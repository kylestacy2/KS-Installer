import {sha256} from '../zip.js';
export const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==','base64'));
export const background=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAyAAAAHgAQAAAAB1fDRYAAAARUlEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvBr1gAAHGkBofAAAAAElFTkSuQmCC','base64'));
export async function collection(){
  const items=[];const files=new Map();
  for(const [group,file,bytes] of [['model-images','Test helicopter.png',png],['wallpapers','Blue #1.png',background],['startup-screens','Welcome.png',background]]){
    const item={id:group+'/'+file,group,file,title:file.slice(0,-4),path:(group==='model-images'?'IMAGES/':'IMAGES/Wallpapers/')+file,size:bytes.length,sha256:await sha256(bytes),width:group==='model-images'?1:800,height:group==='model-images'?1:480};
    items.push(item);files.set(item.path,bytes);
  }
  return {catalog:{schema:1,items},files};
}
