import {sha256} from './zip.js';

const groups=['model-images','wallpapers','startup-screens'];
const check=(ok,message)=>{if(!ok)throw Error(message);};
const hash=/^[a-f0-9]{64}$/;
const filename=/^[^/\\\x00-\x1f\x7f:*?"<>|]+\.png$/i;
const MAX_FILE=16*1024*1024,MAX_TOTAL=128*1024*1024;

export function validateArtwork(items){
  check(Array.isArray(items)&&items.length<=256,'Invalid artwork selection.');
  const paths=new Set(),ids=new Set();let size=0;
  for(const item of items){
    check(item&&typeof item.id==='string'&&item.id.length<=200&&!ids.has(item.id),'Invalid or duplicate artwork ID.');
    check(typeof item.path==='string'&&/^IMAGES\/(?:Wallpapers\/)?[^/]+\.png$/i.test(item.path),'Artwork can only install PNG files in IMAGES.');
    const name=item.path.split('/').at(-1);
    check(filename.test(name)&&!name.startsWith('.')&&name.length<=180&&!/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name),'Invalid artwork filename.');
    check(hash.test(item.sha256)&&Number.isSafeInteger(item.size)&&item.size>=33&&item.size<=MAX_FILE,'Invalid artwork checksum or size.');
    check(!paths.has(item.path.toLowerCase()),'Duplicate artwork destination.');
    size+=item.size;paths.add(item.path.toLowerCase());ids.add(item.id);
  }
  check(size<=MAX_TOTAL,'Choose fewer images (128 MB maximum).');
  return items;
}

export function validateCatalog(value){
  check(value?.schema===1&&Array.isArray(value.items)&&value.items.length<=256,'The artwork collection is unavailable or invalid.');
  const ids=new Set();
  for(const item of value.items){
    validateArtwork([item]);
    check(groups.includes(item.group)&&typeof item.title==='string'&&item.title.length>0&&item.title.length<=200&&!ids.has(item.id),'Invalid artwork collection entry.');
    check(item.id===item.group+'/'+item.file&&filename.test(item.file)&&!item.file.startsWith('.'),'Invalid artwork collection filename.');
    check(item.path===(item.group==='model-images'?'IMAGES/':'IMAGES/Wallpapers/')+item.file,'Invalid artwork destination.');
    check(Number.isInteger(item.width)&&item.width>0&&item.width<=8192&&Number.isInteger(item.height)&&item.height>0&&item.height<=8192,'Invalid image dimensions.');
    if(item.group!=='model-images')check(item.width===800&&item.height===480,'Wallpaper and startup images must be 800 × 480.');
    ids.add(item.id);
  }
  return value.items;
}

export const artworkURL=item=>'./gallery/'+item.group+'/'+encodeURIComponent(item.file);
export const artworkThumbnailURL=item=>'./gallery/tiles/'+item.group+'/'+encodeURIComponent(item.file.replace(/\.png$/i,'.webp'));
export const artworkIdentity=items=>JSON.stringify(validateArtwork(items).map(({id,path,size,sha256})=>({id,path,size,sha256})).sort((a,b)=>a.id.localeCompare(b.id)));

// Keep the release manifest untouched. A gallery image with different bytes at
// a release-owned name gets a separate destination; it cannot replace a pin.
export function selectArtwork(manifest,items){
  const used=new Map(manifest.files.map(f=>[f.path.toLowerCase(),f.sha256])),selected=new Map(),result=[];
  for(const item of [...items].sort((a,b)=>a.id.localeCompare(b.id))){
    let path=item.path;
    if(used.has(path.toLowerCase())&&used.get(path.toLowerCase())!==item.sha256){
      const folder=path.slice(0,path.lastIndexOf('/')+1);
      path=folder+'KSE-'+item.sha256.slice(0,16)+'.png';
    }
    check(!used.has(path.toLowerCase())||used.get(path.toLowerCase())===item.sha256,'Conflicting artwork destination.');
    if(selected.has(path.toLowerCase()))continue; // Identical wallpaper/startup duplicates.
    result.push({...item,path});selected.set(path.toLowerCase(),item.sha256);used.set(path.toLowerCase(),item.sha256);
  }
  return validateArtwork(result);
}

export async function loadCatalog(fetcher=fetch){
  const response=await fetcher('./gallery/catalog.json',{cache:'no-store'});
  check(response.ok,'Cannot load the artwork collection. Retry or continue without images.');
  return validateCatalog(await response.json());
}

export async function loadArtwork(items,{fetcher=fetch,cancel=()=>false,progress=()=>{}}={}){
  validateArtwork(items);const files=new Map();
  for(let i=0;i<items.length;i++){
    const item=items[i];check(!cancel(),'Artwork download cancelled. No radio files changed.');
    const response=await fetcher(artworkURL(item),{cache:'no-store'});
    check(response.ok,'Cannot download '+item.title+'. Retry or clear your artwork selection.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    check(bytes.length===item.size&&await sha256(bytes)===item.sha256,'Artwork checksum mismatch: '+item.title+'. Reload the collection and try again.');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    check([137,80,78,71,13,10,26,10].every((n,j)=>bytes[j]===n)&&view.getUint32(8)===13&&view.getUint32(12)===0x49484452&&view.getUint32(16)===item.width&&view.getUint32(20)===item.height,'Invalid PNG image: '+item.title);
    files.set(item.path,bytes);progress(i+1,items.length,item.path);
  }
  check(!cancel(),'Artwork download cancelled. No radio files changed.');
  return files;
}
