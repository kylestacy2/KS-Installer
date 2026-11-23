// Exercise the real folder-picker/controller branch with injected picker results
// and memory drives. No native picker, physical USB, or real radio writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {MemoryFS,makeDemo} from '../demo.js';
import {BrowserFS} from '../fs.js';
import {Installer} from '../core.js';
import {createBackupZip} from '../backup-zip.js';
import {sha256} from '../zip.js';
import {artworkURL} from '../artwork.js';
import {collection} from './artwork-fixture.mjs';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const app=await readFile(process.env.KSE_PICKER_APP_SOURCE||new URL('../app.js',import.meta.url),'utf8');
const modules=new URL('../',import.meta.url).href;
for(const name of ['list','exists','read','stat','blob','write','remove','openWriter','copyFirmware'])BrowserFS.prototype[name]=function(...args){return this.handle.fs[name](...args);};
const element=()=>({disabled:false,hidden:false,checked:false,open:true,showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},value:'',textContent:'',children:[],classList:{toggle(){}},focus(){document.activeElement=this;},scrollIntoView(){},append(x){this.children.push(x);},replaceChildren(){this.children=[];}});
const abort=()=>new DOMException('User dismissed the folder picker','AbortError');
const handle=fs=>({name:fs.name,fs,isSameEntry:async other=>fs===other.fs,resolve:async other=>fs===other.fs?[]:null});
async function setup(label,existing=null,art=null){
 const f=existing||await makeDemo(),archive=new MemoryFS(),entries=[];
 for(const item of [...f.manifest.files,f.manifest.settings,f.manifest.firmware]){
  const bytes=f.files.get(item.path||'@firmware');item.size=bytes.length;item.archive='EdgeTXKSE/'+(item.path?'SD/'+item.path:'Firmware/test.uf2');
  archive.files.set(item.archive,bytes);entries.push({path:item.archive,size:item.size,sha256:item.sha256});
 }
 await createBackupZip(archive,'release.zip',entries);const blob=await archive.blob('release.zip');f.manifest.zip={size:blob.size,sha256:await sha256(await blob.arrayBuffer())};
 const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element()]));
 for(const id of ['skip-backup-dialog','completion-dialog'])nodes[id].open=false;
 globalThis.document={getElementById:id=>{assert(nodes[id],id);return nodes[id];},createElement:element};
 const responses=[],requests=[];
 globalThis.window={DecompressionStream,addEventListener(){},showDirectoryPicker(options){requests.push(options);assert(responses.length,'No picker response');const result=responses.shift();if(typeof result==='function')return result();return result instanceof Error?Promise.reject(result):Promise.resolve(result);}};
 const downloads=[];globalThis.isSecureContext=true;globalThis.fetch=async url=>{
  if(art&&url.endsWith('catalog.json'))return {ok:true,json:async()=>structuredClone(art.catalog)};
  if(art&&url.startsWith('./gallery/')){downloads.push(url);const item=art.catalog.items.find(item=>artworkURL(item)===url);assert(item,url);return {ok:true,arrayBuffer:async()=>art.files.get(item.path).slice().buffer};}
  return {ok:true,json:async()=>structuredClone(f.manifest)};
 };
 const timer=globalThis.setTimeout;globalThis.setTimeout=(...args)=>{const t=timer(...args);t.unref();return t;};
 await import('data:text/javascript;base64,'+Buffer.from(app.replaceAll("from './", "from '"+modules)+'\n// '+label).toString('base64'));
 const click=async id=>{assert.equal(nodes[id].disabled,false,id+' enabled');await nodes[id].onclick();
  // Also support the pre-fix handler, which did not return its action promise.
  for(let i=0;nodes['choose-sd'].disabled&&i<1000;i++)await pause(1);
  assert.equal(nodes['choose-sd'].disabled,false,'picker/action must release busy state');
 };
 nodes.zip.files=[blob];await nodes.zip.onchange();assert.equal(nodes['release-status'].textContent,'Verified');
 const pick=async(kind,result=handle(f[kind]),step5=false)=>{responses.push(result);await click((step5?'reselect-':'choose-')+kind);};
 const prepared=async()=>{await pick('sd');await pick('boot');nodes['one-radio'].checked=true;nodes['one-radio'].onchange();await click('scan');await pick('backup');await click('backup');await click('install');};
 const confirm=()=>{nodes.reconnected.checked=true;nodes.reconnected.onchange();};
 const state=()=>({title:nodes['stage-title'].textContent,detail:nodes['stage-detail'].textContent,progress:nodes.progress.value,sd:nodes['sd-name'].textContent,boot:nodes['boot-name'].textContent,backup:nodes['backup-name'].textContent,confirmed:nodes.reconnected.checked,verifyDisabled:nodes.verify.disabled,sdWrites:f.sd.writes.length,bootWrites:f.boot.writes.length,backupWrites:f.backup.writes.length,journal:f.backup.files.get('installation.json')?.slice()});
 return {...f,nodes,click,pick,prepared,confirm,state,responses,requests,downloads};
}

for(const kind of ['sd','boot','backup'])test('initial '+kind+' picker cancellation preserves progress and supports immediate retry',async()=>{
 const f=await setup('initial-'+kind);if(kind==='backup'){await f.pick('sd');await f.pick('boot');f.nodes['one-radio'].checked=true;f.nodes['one-radio'].onchange();}
 const before=f.state();await f.pick(kind,abort());assert.deepEqual(f.state(),before);assert.equal(f.nodes.message.hidden,true);assert.equal(document.activeElement,f.nodes['choose-'+kind]);
 await f.pick(kind);assert.equal(f.nodes[kind==='backup'?'backup-name':kind==='boot'?'boot-name':'sd-name'].textContent,kind==='backup'?'Backup folder: '+f.backup.name:f[kind].name);
});

for(const step5 of [false,true])for(const kind of ['sd','boot'])for(const selected of ['none','other','both'])test((step5?'step 05':'step 02')+' after UF2: cancel '+kind+' twice with '+selected+' drives selected, retry and finish without another flash',async()=>{
 const f=await setup('postflash-'+step5+'-'+kind+'-'+selected);await f.prepared();
 if(selected!=='none')await f.pick(kind==='sd'?'boot':'sd',undefined,step5);if(selected==='both'){await f.pick(kind,undefined,step5);f.confirm();}
 const before=f.state();
 for(let i=0;i<2;i++){await f.pick(kind,abort(),step5);assert.deepEqual(f.state(),before);assert.equal(f.nodes.message.hidden,true);assert.equal(f.nodes[step5?'step-verify':'step-radio'].open,true);assert.equal(document.activeElement,f.nodes[(step5?'reselect-':'choose-')+kind]);assert.equal(f.nodes.install.disabled,true);assert.equal(f.nodes.restore.disabled,true);}
 await f.pick(kind,undefined,step5);if(selected==='none')await f.pick(kind==='sd'?'boot':'sd',undefined,step5);
 assert.equal(f.nodes.verify.disabled,true,'reselecting a drive requires confirming restart again');f.confirm();await f.click('verify');
 assert.equal(f.nodes['stage-title'].textContent,'Installation verified.');assert.equal(f.nodes['completion-dialog'].open,true);assert.equal(f.nodes['completion-title'].textContent,'Update complete!');assert.equal(f.nodes['completion-next'].hidden,false);assert.equal(f.boot.writes.filter(p=>p==='KSE.UF2').length,1);assert.equal(f.sd.writes.length,before.sdWrites);
});

test('cancelling the backup picker after firmware preserves the existing recovery journal and verified state',async()=>{
 const f=await setup('backup-after-flash');await f.prepared();await f.pick('sd');await f.pick('boot');f.confirm();const before=f.state();
 await f.pick('backup',abort());assert.deepEqual(f.state(),before);assert.equal(document.activeElement,f.nodes['choose-backup']);await f.click('verify');assert.equal(f.nodes['stage-title'].textContent,'Installation verified.');
});

test('synchronous picker AbortError releases busy state and allows retry',async()=>{
 const f=await setup('sync-abort');await f.prepared();const before=f.state();await f.pick('sd',()=>{throw abort();});assert.deepEqual(f.state(),before);await f.pick('sd');assert.equal(f.nodes['sd-name'].textContent,f.sd.name);
});

test('permission rejection stays an error and allows another folder-selection attempt',async()=>{
 const f=await setup('permission');await f.prepared();await f.pick('sd',new DOMException('Drive permission denied','NotAllowedError'));
 assert.equal(f.nodes.message.hidden,false);assert.match(f.nodes.message.textContent,/permission denied/);assert.equal(f.nodes.verify.disabled,true);await f.pick('sd');assert.equal(f.nodes['sd-name'].textContent,f.sd.name);
});

test('AbortError during folder validation is not mistaken for a dismissed picker',async()=>{
 const f=await setup('read-abort');await f.prepared();const candidate=handle(f.sd);candidate.isSameEntry=async()=>{throw abort();};candidate.resolve=async()=>{throw abort();};
 // checkHandles first calls the already selected backup handle, then candidate.resolve.
 await f.pick('sd',candidate);assert.equal(f.nodes.message.hidden,false);assert.equal(f.nodes.verify.disabled,true);await f.pick('sd');assert.equal(f.nodes['sd-name'].textContent,f.sd.name);
});

test('a pending picker blocks a second picker and a later cancel still permits retry',async()=>{
 const f=await setup('pending-picker');let dismiss;f.responses.push(()=>new Promise((_,reject)=>dismiss=reject));
 const pending=f.nodes['choose-sd'].onclick(),count=f.requests.length;assert.equal(f.nodes['choose-boot'].disabled,true);
 await f.nodes['choose-boot'].onclick();assert.equal(f.requests.length,count);dismiss(abort());await pending;
 assert.equal(f.nodes['choose-sd'].disabled,false);assert.equal(f.nodes['choose-boot'].disabled,false);await f.pick('sd');assert.equal(f.nodes['sd-name'].textContent,f.sd.name);
});

test('step five completes after radio settings change across the restart without repeating installation',async()=>{
 const f=await setup('restart-settings-changed');await f.prepared();
 f.sd.files.set('RADIO/radio.yml',new TextEncoder().encode('board: tx16smk3\nlastRun: 42'));
 const writes=f.sd.writes.length;await f.pick('sd',undefined,true);await f.pick('boot',undefined,true);f.confirm();await f.click('verify');
 assert.equal(f.nodes['stage-title'].textContent,'Installation verified.');assert.match(f.nodes['final-result'].textContent,/4 installed SD files/);assert.equal(f.sd.writes.length,writes);assert.equal(f.boot.writes.filter(p=>p==='KSE.UF2').length,1);
});

test('step five installed-file failure names the file and permits verification retry without copying firmware',async()=>{
 const f=await setup('verify-file-retry');await f.prepared();await f.pick('sd',undefined,true);await f.pick('boot',undefined,true);f.confirm();
 const path='SCRIPTS/RF2/rf2.lua',bytes=f.sd.files.get(path).slice();f.sd.files.get(path)[0]^=1;
 await f.click('verify');assert.match(f.nodes.message.textContent,/rf2.lua/);assert.equal(f.nodes['next-steps'].hidden,true);assert.equal(f.nodes.verify.disabled,false);assert.equal(f.nodes.install.disabled,true);
 f.sd.files.set(path,bytes);await f.click('verify');assert.equal(f.nodes['stage-title'].textContent,'Installation verified.');assert.equal(f.nodes['completion-dialog'].open,true);assert.equal(f.nodes['completion-title'].textContent,'Update complete!');assert.equal(f.nodes['completion-next'].hidden,false);assert.equal(f.boot.writes.filter(p=>p==='KSE.UF2').length,1);
});


test('a saved SD-verified journal resumes the combined update without reinstalling SD files',async()=>{
 const f=await setup('saved-sd-only'),copy=Installer.prototype.copyFirmware;
 Installer.prototype.copyFirmware=async()=>{throw Error('Preflight interrupted before writing');};
 try{await f.prepared();}finally{Installer.prototype.copyFirmware=copy;}
 assert.equal(f.boot.writes.length,0);const writes=f.sd.writes.length;
 const next=await setup('resumed-sd-only',f);
 await next.pick('sd');await next.pick('boot');next.nodes['one-radio'].checked=true;next.nodes['one-radio'].onchange();await next.pick('backup');
 assert.equal(next.nodes.install.textContent,'Continue update');assert.equal(next.nodes.install.disabled,false);
 assert.equal(document.activeElement,next.nodes['step-sd-heading']);
 await next.click('install');assert.equal(next.sd.writes.length,writes);assert.deepEqual(next.boot.writes,['KSE.UF2']);
 await next.pick('sd',undefined,true);await next.pick('boot',undefined,true);next.confirm();await next.click('verify');
 assert.equal(next.nodes['stage-title'].textContent,'Installation verified.');
});

for(const phase of ['backup-verified','sd-verified','firmware-copied'])test('saved artwork resumes from '+phase+' with trusted catalog checks and correct download behavior',async()=>{
 const art=await collection(),f=await setup('art-save-'+phase,null,art);await f.click('choose-artwork');
 const checkbox=f.nodes['artwork-grid'].children[1].children[0];checkbox.checked=true;checkbox.onchange();
 await f.pick('sd');await f.pick('boot');f.nodes['one-radio'].checked=true;f.nodes['one-radio'].onchange();await f.click('scan');await f.pick('backup');await f.click('backup');
 if(phase==='sd-verified'){
  const copy=Installer.prototype.copyFirmware;Installer.prototype.copyFirmware=async()=>{throw Error('Preflight interrupted');};
  try{await f.click('install');}finally{Installer.prototype.copyFirmware=copy;}
 }else if(phase==='firmware-copied')await f.click('install');
 const previousWrites=f.sd.writes.length,next=await setup('art-resume-'+phase,f,art);
 await next.pick('sd');await next.pick('boot');next.nodes['one-radio'].checked=true;next.nodes['one-radio'].onchange();await next.pick('backup');
 assert.match(next.nodes['artwork-summary'].textContent,/1 image selected/);assert.equal(next.downloads.length,0);assert(next.nodes['choose-artwork'].disabled);
 if(phase!=='firmware-copied')await next.click('install');
 assert.equal(next.downloads.length,phase==='backup-verified'?1:0);
 if(phase!=='backup-verified')assert.equal(f.sd.writes.length,previousWrites);
 await next.pick('sd',undefined,true);await next.pick('boot',undefined,true);next.confirm();await next.click('verify');
 assert.equal(next.nodes['completion-dialog'].open,true);assert.equal(next.nodes['completion-artwork'].hidden,false);assert.equal(next.nodes['artwork-after-install'].hidden,false);
 assert.equal(f.boot.writes.filter(path=>path==='KSE.UF2').length,1);
});

test('changed catalog artwork cannot resume a saved flash or authorize a write',async()=>{
 const art=await collection(),f=await setup('art-save-changed',null,art);await f.click('choose-artwork');const input=f.nodes['artwork-grid'].children[0].children[0];input.checked=true;input.onchange();
 await f.pick('sd');await f.pick('boot');f.nodes['one-radio'].checked=true;f.nodes['one-radio'].onchange();await f.click('scan');await f.pick('backup');await f.click('backup');
 const changed=structuredClone(art);changed.catalog.items[0].sha256='a'.repeat(64);
 const next=await setup('art-resume-changed',f,changed);await next.pick('sd');await next.pick('boot');next.nodes['one-radio'].checked=true;next.nodes['one-radio'].onchange();await next.pick('backup');
 assert.match(next.nodes.message.textContent,/differs from the current collection/);assert(next.nodes.install.disabled);assert(next.nodes.verify.disabled);assert.equal(f.sd.writes.length,0);assert.equal(f.boot.writes.length,0);
});
