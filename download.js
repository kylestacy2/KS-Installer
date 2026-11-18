import {loadRelease,safePath} from './zip.js';

const MAX_BUNDLE=160*1024*1024,MAX_MANIFEST=1024*1024;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const check=(ok,message)=>{if(!ok)throw Error(message);};

export function validateDownload(manifest){
  check(manifest?.schema===1&&manifest.board==='tx16smk3'&&manifest.firmwareWriteEnabled===true,'This download is not a supported MK3 release.');
  check(/^trial-\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)*$/.test(manifest.id),'Invalid release identifier.');
  check(typeof manifest.label==='string'&&manifest.label.length<=200,'Invalid release label.');
  const d=manifest.download;
  check(d&&hash(d.sha256)&&Number.isSafeInteger(d.size)&&d.size>=22&&d.size<=MAX_BUNDLE,'Automatic download is unavailable for this release.');
  check(d.path==='payloads/'+d.sha256+'.zip','Invalid release download location.');
  check(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=9998,'Invalid release file list.');
  const names=new Set(),paths=new Set();
  for(const file of [...manifest.files,manifest.settings,manifest.firmware]){
    check(file&&hash(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=16*1024*1024,'Invalid release file details.');
    safePath(file.archive);
    check(file.archive.startsWith('EdgeTXKSE/')&&!names.has(file.archive.toLowerCase()),'Invalid or duplicate release archive path.');
    names.add(file.archive.toLowerCase());
    if(file.path){safePath(file.path);check(!paths.has(file.path.toLowerCase()),'Duplicate release file path.');paths.add(file.path.toLowerCase());}
  }
  check(manifest.settings.path==='SCRIPTS/RF2/settings.lua'&&manifest.settings.archive==='EdgeTXKSE/First Install/SCRIPTS/RF2/settings.lua','Invalid first-install settings.');
  check(manifest.firmware.archive==='EdgeTXKSE/Firmware/TX16S-MK3-MAX-2.12.1-KS.uf2'&&!manifest.firmware.path,'Invalid firmware download.');
  for(const file of manifest.files){
    check(typeof file.path==='string'&&file.archive==='EdgeTXKSE/SD-CARD/'+file.path,'Invalid SD download path.');
    check(!/^(RADIO|MODELS)\//i.test(file.path)&&!file.path.toLowerCase().endsWith('.luac'),'Unexpected radio data in release.');
  }
  return manifest;
}

// Bounded, same-origin downloads. Never use account cookies or follow redirects.
async function readDownload(url,{signal,fetchImpl=fetch,maximum,exact,progress=()=>{},timeoutMs=30000}={}){
  const controller=new AbortController();let timer,reader,timedOut=false;
  const abort=()=>controller.abort();
  const checkAbort=()=>{
    if(signal?.aborted)throw Error('Download cancelled. Radio unchanged.');
    if(timedOut)throw Error('Download timed out. Check your connection and try again.');
  };
  const armTimeout=()=>{clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const cancelReader=()=>{reader?.cancel().catch(()=>{});};
  controller.signal.addEventListener('abort',cancelReader,{once:true});
  try{
    checkAbort();armTimeout();
    const response=await fetchImpl(url,{cache:'no-store',credentials:'omit',mode:'same-origin',redirect:'error',signal:controller.signal});
    checkAbort();
    check(response.ok&&!response.redirected,'Could not download KSE Touch (HTTP '+response.status+'). Please try again.');
    const length=response.headers.get('content-length');
    if(length!==null){
      check(/^\d+$/.test(length),'Invalid download size.');
      const size=Number(length);
      check(Number.isSafeInteger(size)&&size<=maximum&&(exact===undefined||size===exact),'Download size does not match this release.');
    }
    check(response.body,'This browser cannot read the download.');
    reader=response.body.getReader();const chunks=[];let bytes=0;
    for(;;){
      checkAbort();armTimeout();const {value,done}=await reader.read();checkAbort();if(done)break;
      bytes+=value.byteLength;
      check(bytes<=maximum&&(exact===undefined||bytes<=exact),'Download exceeds the expected size.');
      chunks.push(value);progress(bytes,exact||maximum);
    }
    check(exact===undefined||bytes===exact,'Download was interrupted. Please try again.');
    return new Blob(chunks);
  }catch(error){
    checkAbort();
    if(error instanceof TypeError)throw Error('Download failed. Check your connection and try again.');
    throw error;
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    controller.signal.removeEventListener('abort',cancelReader);
    if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}

export async function fetchLatestRelease(options={}){
  const blob=await readDownload('./release.json',{...options,maximum:MAX_MANIFEST});
  let manifest;try{manifest=JSON.parse(await blob.text());}catch{throw Error('Release information is invalid. Please try again.');}
  return validateDownload(manifest);
}

export async function downloadRelease(manifest,{signal,fetchImpl,progress,verifyProgress,timeoutMs}={}){
  validateDownload(manifest);
  const blob=await readDownload('./'+manifest.download.path,{signal,fetchImpl,progress,timeoutMs,maximum:manifest.download.size,exact:manifest.download.size});
  // ZIP, every resource and the existing UF2 guard must pass before app.js accepts it.
  return loadRelease(blob,{...manifest,zip:manifest.download},verifyProgress,()=>!!signal?.aborted);
}
