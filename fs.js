import {safePath} from './zip.js';
import {transferUF2,UF2_FILENAME} from './core.js';
const ignored = new Set(['.Spotlight-V100','.Trashes','.fseventsd','.TemporaryItems','System Volume Information','$RECYCLE.BIN','.DS_Store']);
export function ignoredPath(path){return path.split('/').some(p=>ignored.has(p)||p.startsWith('._'));}
// Handles remain in this tab only; radio contents never go to a server.
export class BrowserFS {
  constructor(handle,{readOnly=false}={}){this.handle=handle;this.name=handle.name;this.readOnly=readOnly;}
  async file(path,create=false){
    safePath(path);const parts=path.split('/'),name=parts.pop();let h=this.handle;
    for(const p of parts)h=await h.getDirectoryHandle(p,{create});
    return h.getFileHandle(name,{create});
  }
  async list(){
    const result=[],seen=new Set();
    const walk=async(h,prefix='',depth=0)=>{
      if(depth>32)throw Error('Folder nesting exceeds supported depth');
      for await(const [name,entry]of h.entries()){
        const path=prefix+name;if(ignoredPath(path))continue;safePath(path);
        const key=path.toLowerCase();if(seen.has(key))throw Error('Ambiguous filename: '+path);seen.add(key);
        if(seen.size>100000)throw Error('Too many files for this prototype');
        if(entry.kind==='directory')await walk(entry,path+'/',depth+1);else result.push(path);
      }
    };
    await walk(this.handle);return result.sort();
  }
  async read(path){const f=await(await this.file(path)).getFile();if(f.size>256*1024*1024)throw Error('File exceeds the prototype backup limit (256 MB): '+path);return new Uint8Array(await f.arrayBuffer());}
  async blob(path){return (await this.file(path)).getFile();}
  async exists(path){try{await this.file(path);return true;}catch(e){if(e.name==='NotFoundError')return false;throw e;}}
  async openWriter(path){
    if(this.readOnly)throw Error('Firmware drive is read-only except for the dedicated UF2 copy step');
    return (await this.file(path,true)).createWritable();
  }
  async copyFirmware(bytes,progress){
    if(!this.readOnly)throw Error('Choose the dedicated firmware drive for UF2 copying');
    // Fixed filename only. Generic writes and deletion remain prohibited.
    await transferUF2(async()=> (await this.file(UF2_FILENAME,true)).createWritable(),bytes,progress);
  }
  async write(path,bytes){
    const stream=await this.openWriter(path);
    try{await stream.write(bytes);await stream.close();}catch(e){await stream.abort().catch(()=>{});throw e;}
  }
  async remove(path){
    if(this.readOnly)throw Error('Firmware drive is read-only except for the dedicated UF2 copy step');
    safePath(path);const parts=path.split('/'),name=parts.pop();let h=this.handle;
    for(const p of parts)h=await h.getDirectoryHandle(p);await h.removeEntry(name);
  }
}
export async function separateHandles(handles){
  for(let i=0;i<handles.length;i++)for(let j=i+1;j<handles.length;j++){
    if(await handles[i].isSameEntry(handles[j]) || await handles[i].resolve(handles[j])!==null || await handles[j].resolve(handles[i])!==null)throw Error('Choose separate radio drives and a backup folder on your computer, outside both drives.');
  }
}
