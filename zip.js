// ZIP reader for the pinned release. No network, dependencies or archive extraction.
export const utf8 = new TextDecoder('utf-8', {fatal: true});
export const encode = text => new TextEncoder().encode(text);
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
}
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/')) throw Error('Unsafe file path');
  if (path.split('/').some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(x))) throw Error('Unsafe file path');
  return path;
}
export class ReleaseZip {
  static async open(blob, expected) {
    if (blob.size > 160*1024*1024 || blob.size !== expected.size) throw Error('Choose the complete, unchanged EdgeTXKSE.zip for this release.');
    if (await sha256(await blob.arrayBuffer()) !== expected.sha256) throw Error('Release ZIP checksum does not match. Download a fresh copy.');
    return ReleaseZip.parse(blob);
  }
  static async parse(blob) {
    if (blob.size < 22 || blob.size > 160*1024*1024) throw Error('Invalid ZIP size');
    const tailStart=Math.max(0,blob.size-65557), tail=new Uint8Array(await blob.slice(tailStart).arrayBuffer()), t=new DataView(tail.buffer);
    let end=-1;
    for (let n=tail.length-22;n>=0;n--) if(t.getUint32(n,true)===0x06054b50 && n+22+t.getUint16(n+20,true)===tail.length){end=n;break;}
    if(end<0) throw Error('ZIP directory is missing');
    const count=t.getUint16(end+10,true), size=t.getUint32(end+12,true), offset=t.getUint32(end+16,true);
    if(t.getUint16(end+4,true)||t.getUint16(end+6,true)||count!==t.getUint16(end+8,true)||count>10000||size>8*1024*1024||offset+size!==tailStart+end) throw Error('Unsupported ZIP directory');
    const directory=new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer()), view=new DataView(directory.buffer);
    const entries=new Map(), names=new Set();let pos=0;
    for(let i=0;i<count;i++) {
      if(pos+46>size || view.getUint32(pos,true)!==0x02014b50) throw Error('Invalid ZIP entry');
      const flags=view.getUint16(pos+8,true), method=view.getUint16(pos+10,true), compressed=view.getUint32(pos+20,true), length=view.getUint32(pos+24,true), nameLength=view.getUint16(pos+28,true), extra=view.getUint16(pos+30,true), comment=view.getUint16(pos+32,true), start=view.getUint32(pos+42,true);
      if(pos+46+nameLength+extra+comment>size || flags&1 || ![0,8].includes(method) || compressed===0xffffffff || length===0xffffffff || start+30>offset || view.getUint16(pos+34,true)) throw Error('Unsupported ZIP entry');
      const name=utf8.decode(directory.subarray(pos+46,pos+46+nameLength));
      safePath(name.endsWith('/')?name.slice(0,-1):name);
      const key=name.toLowerCase().replace(/\/$/,'');
      if(names.has(key)) throw Error('Duplicate ZIP path');names.add(key);
      if(((view.getUint32(pos+38,true)>>>16)&0xf000)===0xa000)throw Error('ZIP links are not supported');
      if(!name.startsWith('EdgeTXKSE/')) throw Error('Unexpected ZIP root');
      entries.set(name,{name,start,compressed,length,method,flags});pos+=46+nameLength+extra+comment;
    }
    if(pos!==size)throw Error('Invalid ZIP directory length');
    return new ReleaseZip(blob,entries,offset);
  }
  constructor(blob,entries,end){this.blob=blob;this.entries=entries;this.end=end;}
  async read(path,expected) {
    const e=this.entries.get(path);if(!e)throw Error('Package file is missing: '+path);
    if(e.length!==expected.size || e.length>16*1024*1024)throw Error('Invalid package file size: '+path);
    const h=new DataView(await this.blob.slice(e.start,e.start+30).arrayBuffer());
    if(h.getUint32(0,true)!==0x04034b50 || h.getUint16(6,true)!==e.flags || h.getUint16(8,true)!==e.method)throw Error('ZIP local header mismatch');
    const n=h.getUint16(26,true), extra=h.getUint16(28,true), start=e.start+30+n+extra;
    if(start+e.compressed>this.end)throw Error('ZIP data outside archive');
    if(utf8.decode(await this.blob.slice(e.start+30,e.start+30+n).arrayBuffer())!==e.name)throw Error('ZIP local filename mismatch');
    const blob=this.blob.slice(start,start+e.compressed);
    const reader=(e.method===8?blob.stream().pipeThrough(new DecompressionStream('deflate-raw')):blob.stream()).getReader();
    const chunks=[];let total=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>e.length)throw Error('Expanded ZIP file too large');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    if(total!==e.length)throw Error('Incomplete ZIP file');
    const result=new Uint8Array(total);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}
    if(await sha256(result)!==expected.sha256)throw Error('Package file checksum mismatch: '+path);
    return result;
  }
}
export async function loadRelease(blob,manifest,progress=()=>{},cancel=()=>false) {
  if(cancel())throw Error('Release check cancelled. Radio unchanged.');
  const zip=await ReleaseZip.open(blob,manifest.zip), files=new Map();
  const all=[...manifest.files,manifest.settings,manifest.firmware];
  for(let i=0;i<all.length;i++){
    if(cancel())throw Error('Release check cancelled. Radio unchanged.');
    const f=all[i];files.set(f.path || '@firmware',await zip.read(f.archive,f));progress(i+1,all.length,f.path||'Firmware');
  }
  return files;
}
