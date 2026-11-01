import {encode,sha256} from './zip.js';
import {transferUF2,UF2_FILENAME} from './core.js';
export class MemoryFS {
  constructor(files={},name='Demo drive'){this.files=new Map(Object.entries(files).map(([p,b])=>[p,new Uint8Array(b)]));this.name=name;this.writes=[];this.fail=null;}
  async list(){return [...this.files.keys()].sort();}
  async exists(p){return this.files.has(p);}
  async read(p){if(!this.files.has(p))throw Error('Disconnected or missing file: '+p);return this.files.get(p).slice();}
  async blob(p){return new Blob([await this.read(p)]);}
  async openWriter(p){
    const parts=[];let stopped=false;
    return {
      write:async b=>{if(stopped)throw Error('Stream closed');if(this.fail)this.fail('stream-write',p,b);parts.push(new Uint8Array(b));},
      close:async()=>{if(stopped)throw Error('Stream closed');if(this.fail)this.fail('stream-close',p);await this.write(p,new Uint8Array(await new Blob(parts).arrayBuffer()));stopped=true;parts.length=0;},
      abort:async()=>{stopped=true;parts.length=0;}
    };
  }
  async write(p,b){if(this.fail)this.fail('write',p,b);this.files.set(p,new Uint8Array(b));this.writes.push(p);}
  async remove(p){if(this.fail)this.fail('remove',p);this.files.delete(p);this.writes.push(p);}
}
export function demoUF2(value,{installer=false}={}){
  const addresses=[...Array.from({length:256},(_,i)=>0x08000000+i*256),0x2001fffc,0x90000000,0x90000100];
  const bytes=new Uint8Array(addresses.length*512),v=new DataView(bytes.buffer);
  addresses.forEach((a,i)=>{
    const p=i*512,metadata=a===0x2001fffc;
    [0x0a324655,0x9e5d5157,installer&&a<0x90000000?0x2001:0x2000,a,metadata?4:256,i,addresses.length,0x6db66082].forEach((x,n)=>v.setUint32(p+n*4,x,true));
    bytes.fill(a>=0x90000000?value:7,p+32,p+32+(metadata?4:256));v.setUint32(p+508,0x0ab16f30,true);
  });return bytes;
}
export class MemoryBootFS extends MemoryFS {
  async copyFirmware(bytes,progress){
    await transferUF2(()=>this.openWriter(UF2_FILENAME),bytes,progress);
    // Emulate the bootloader's resulting readback only after stream completion.
    // Tests separately inject partial writes, stale readback and disconnects.
    const current=bytes.slice(),before=await this.read('CURRENT.UF2'),v=new DataView(current.buffer);
    const original=new Map();
    for(let p=0;p<before.length;p+=512)original.set(new DataView(before.buffer).getUint32(p+12,true),before.subarray(p+32,p+288));
    for(let p=0;p<current.length;p+=512){const address=v.getUint32(p+12,true);if(address>=0x08000000&&address<0x08010000)current.set(original.get(address),p+32);v.setUint32(p+8,0,true);}
    this.files.set('CURRENT.UF2',current);
  }
}
export async function makeDemo(){
  const payload={'SCRIPTS/RF2/rf2.lua':encode('-- demo RF Setup update'),'WIDGETS/KSETouch/main.lua':encode('-- demo dashboard update'),'WIDGETS/KSETouch/layoutEditor.lua':encode('-- demo layout editor'),'SCRIPTS/RF2/PREFS/README.txt':encode('Keep your per-model preferences.')};
  const files=new Map(Object.entries(payload));const firmware=demoUF2(2,{installer:true});files.set('@firmware',firmware);files.set('SCRIPTS/RF2/settings.lua',encode('return { useLvgl=1 }'));
  const manifest={schema:1,id:'demo-only',label:'Simulated installation',board:'tx16smk3',files:await Promise.all(Object.entries(payload).map(async([path,b])=>({path,sha256:await sha256(b),size:b.length}))),settings:{path:'SCRIPTS/RF2/settings.lua',sha256:await sha256(files.get('SCRIPTS/RF2/settings.lua'))},firmware:{sha256:await sha256(firmware)},firmwareWriteEnabled:true};
  const sd=new MemoryFS({'RADIO/radio.yml':encode('board: tx16smk3\n'), 'MODELS/model1.yml':encode('name: Demo helicopter\n'),'SCRIPTS/RF2/rf2.lua':encode('-- previous RF Setup'),'SCRIPTS/RF2/old.luac':encode('old program cache'),'SCRIPTS/RF2/settings.lua':encode('return { hangar={theme="graphite"} }'),'SCRIPTS/RF2/PREFS/model1.a':encode('saved layout and favorites'),'WIDGETS/KSETouch/main.lua':encode('-- previous dashboard'),'IMAGES/My helicopter.png':encode('personal photo'),'LOGS/flight.csv':encode('personal flight log')},'Demo SD card');
  const boot=new MemoryBootFS({'INFO_UF2.TXT':encode('UF2 Bootloader\nBoard-ID: tx16smk3\n'),'CURRENT.UF2':demoUF2(1)},'Demo EDGETX_UF2');
  return {manifest,files,sd,boot,backup:new MemoryFS({},'Demo computer backup')};
}
