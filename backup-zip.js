import {encode,sha256,safePath} from './zip.js';

// STORE archives avoid compression work and stream directly to the computer.
// ZIP64 end records/offsets support the existing 32 GB / 100,000-file scan limits.
const U32=0xffffffff, CHUNK=1024*1024;
const check=(ok,message)=>{if(!ok)throw Error(message);};
const crcTable=Uint32Array.from({length:256},(_,n)=>{
  for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;
  return n>>>0;
});
export function crc32(bytes,crc=0){
  crc^=U32;
  for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  return (crc^U32)>>>0;
}
function record(size){const bytes=new Uint8Array(size);return {bytes,v:new DataView(bytes.buffer)};}
function dosTime(date){
  const d=new Date(date);check(Number.isFinite(d.getTime()),'Invalid ZIP timestamp');
  return {time:(d.getUTCHours()<<11)|(d.getUTCMinutes()<<5)|(d.getUTCSeconds()>>1),date:((Math.min(2107,Math.max(1980,d.getUTCFullYear()))-1980)<<9)|((d.getUTCMonth()+1)<<5)|d.getUTCDate()};
}
function localHeader(e,stamp){
  const {bytes,v}=record(30+e.name.length);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);
  v.setUint16(10,stamp.time,true);v.setUint16(12,stamp.date,true);v.setUint32(14,e.crc32,true);
  v.setUint32(18,e.size,true);v.setUint32(22,e.size,true);v.setUint16(26,e.name.length,true);
  bytes.set(e.name,30);return bytes;
}
function centralHeader(e,stamp){
  const wide=e.offset>=U32,extra=wide?12:0,{bytes,v}=record(46+e.name.length+extra);
  v.setUint32(0,0x02014b50,true);v.setUint16(4,45,true);v.setUint16(6,wide?45:20,true);v.setUint16(8,0x800,true);
  v.setUint16(12,stamp.time,true);v.setUint16(14,stamp.date,true);v.setUint32(16,e.crc32,true);
  v.setUint32(20,e.size,true);v.setUint32(24,e.size,true);v.setUint16(28,e.name.length,true);v.setUint16(30,extra,true);
  v.setUint32(42,wide?U32:e.offset,true);bytes.set(e.name,46);
  if(wide){const n=46+e.name.length;v.setUint16(n,1,true);v.setUint16(n+2,8,true);v.setBigUint64(n+4,BigInt(e.offset),true);}
  return bytes;
}
function ending(count,size,offset){
  const wide=count>=0xffff||size>=U32||offset>=U32,{bytes,v}=record(wide?98:22);let p=0;
  if(wide){
    v.setUint32(0,0x06064b50,true);v.setBigUint64(4,44n,true);v.setUint16(12,45,true);v.setUint16(14,45,true);
    v.setBigUint64(24,BigInt(count),true);v.setBigUint64(32,BigInt(count),true);v.setBigUint64(40,BigInt(size),true);v.setBigUint64(48,BigInt(offset),true);
    v.setUint32(56,0x07064b50,true);v.setBigUint64(64,BigInt(offset+size),true);v.setUint32(72,1,true);p=76;
  }
  v.setUint32(p,0x06054b50,true);v.setUint16(p+8,Math.min(count,0xffff),true);v.setUint16(p+10,Math.min(count,0xffff),true);
  v.setUint32(p+12,Math.min(size,U32),true);v.setUint32(p+16,Math.min(offset,U32),true);return bytes;
}
export function zipLayout(entries){
  check(Array.isArray(entries)&&entries.length>0&&entries.length<=100010,'Invalid ZIP entry count');
  let offset=0;const seen=new Set(),files=entries.map(entry=>{
    const path=safePath(entry.path),key=path.toLowerCase(),name=encode(path);
    check(!seen.has(key),'Duplicate ZIP filename');seen.add(key);
    check(Number.isInteger(entry.size)&&entry.size>=0&&entry.size<=256*1024*1024,'ZIP entry exceeds the 256 MB file limit');
    check(/^[a-f0-9]{64}$/.test(entry.sha256),'Invalid ZIP entry checksum');
    const result={...entry,name,offset};offset+=30+name.length+entry.size;return result;
  });
  check(offset<=33*1024**3,'ZIP exceeds the backup size limit');
  const directorySize=files.reduce((n,e)=>n+46+e.name.length+(e.offset>=U32?12:0),0),end=ending(files.length,directorySize,offset);
  return {files,directoryOffset:offset,directorySize,end,size:offset+directorySize+end.length};
}
const cancelled=cancel=>check(!cancel(),'ZIP operation cancelled. Radio unchanged.');
async function checksum(bytes,cancel){
  let crc=0;
  for(let p=0;p<bytes.length;p+=CHUNK){
    cancelled(cancel);crc=crc32(bytes.subarray(p,p+CHUNK),crc);
    // Let Cancel and progress paint even when testing with memory-only drives.
    if(p&&p%(8*CHUNK)===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  return crc;
}
async function sameBytes(blob,offset,expected){
  const actual=new Uint8Array(await blob.slice(offset,offset+expected.length).arrayBuffer());
  check(actual.length===expected.length&&actual.every((v,i)=>v===expected[i]),'ZIP structure failed verification');
}
export async function verifyBackupZip(fs,archive,{progress=()=>{},cancel=()=>false}={}){
  check(archive?.format==='zip-store-v1','Complete a verified ZIP backup first.');safePath(archive.path);
  const layout=zipLayout(archive.entries),stamp=dosTime(archive.created),blob=await fs.blob(archive.path);
  check(blob.size===layout.size&&archive.size===layout.size,'ZIP size failed verification');
  for(let i=0;i<layout.files.length;i++){
    cancelled(cancel);const e=layout.files[i];check(Number.isInteger(e.crc32)&&e.crc32>=0&&e.crc32<=U32,'Invalid ZIP CRC');
    const header=localHeader(e,stamp);await sameBytes(blob,e.offset,header);
    const bytes=new Uint8Array(await blob.slice(e.offset+header.length,e.offset+header.length+e.size).arrayBuffer());
    check(await sha256(bytes)===e.sha256&&await checksum(bytes,cancel)===e.crc32,'ZIP contents failed verification: '+e.path);
    progress(i+1,layout.files.length,e.path);
  }
  let p=layout.directoryOffset;
  for(const e of layout.files){cancelled(cancel);const bytes=centralHeader(e,stamp);await sameBytes(blob,p,bytes);p+=bytes.length;}
  await sameBytes(blob,p,layout.end);cancelled(cancel);return archive;
}
export async function createBackupZip(fs,path,entries,{created=new Date().toISOString(),progress=()=>{},cancel=()=>false}={}){
  safePath(path);check(!await fs.exists(path),'ZIP backup already exists');
  const layout=zipLayout(entries),stamp=dosTime(created);
  check(!layout.files.some(e=>e.path.toLowerCase()===path.toLowerCase()),'ZIP cannot contain itself');
  cancelled(cancel);const stream=await fs.openWriter(path);let closed=false;
  try{
    for(let i=0;i<layout.files.length;i++){
      cancelled(cancel);const e=layout.files[i],bytes=await fs.read(e.path);
      check(bytes.length===e.size&&await sha256(bytes)===e.sha256,'Backup changed before ZIP creation: '+e.path);
      e.crc32=await checksum(bytes,cancel);await stream.write(localHeader(e,stamp));
      for(let p=0;p<bytes.length;p+=CHUNK){cancelled(cancel);await stream.write(bytes.subarray(p,p+CHUNK));}
      progress(i+1,layout.files.length,e.path);
    }
    for(const e of layout.files){cancelled(cancel);await stream.write(centralHeader(e,stamp));}
    await stream.write(layout.end);cancelled(cancel);await stream.close();closed=true;
    const archive={format:'zip-store-v1',path,created,size:layout.size,entries:layout.files.map(({name,offset,...e})=>e)};
    await verifyBackupZip(fs,archive,{progress,cancel});return archive;
  }catch(error){
    if(!closed)await stream.abort().catch(()=>{});
    // Leave the complete loose backup intact. A partial/unverified ZIP cannot enable Install.
    await fs.remove(path).catch(()=>{});throw error;
  }
}
