import test from 'node:test';
import assert from 'node:assert/strict';
import {Installer,JOURNAL} from '../core.js';
import {makeDemo} from '../demo.js';
import {encode,sha256} from '../zip.js';
import {validateArtwork,validateCatalog,loadArtwork,loadCatalog,artworkURL,artworkIdentity,selectArtwork} from '../artwork.js';
import {collection,png} from './artwork-fixture.mjs';

async function fixture({existing=false,skip=false}={}){
  const f=await makeDemo(),assets=await collection();f.artwork=assets.catalog.items;
  for(const [path,bytes] of assets.files)f.files.set(path,bytes);
  if(existing)for(const item of f.artwork)f.sd.files.set(item.path.toLowerCase(),encode('my original '+item.path));
  f.engine=new Installer(f);await f.engine.scan();
  if(skip)await f.engine.skipBackup({confirmed:true});else await f.engine.createBackup();
  return f;
}
const snapshot=async fs=>Object.fromEntries(await Promise.all((await fs.list()).map(async p=>[p,await sha256(await fs.read(p))])));

test('catalog downloads verify exact PNG bytes and escaped filenames for all three categories',async()=>{
  const {catalog,files}=await collection(),items=validateCatalog(catalog),urls=[];
  const downloaded=await loadArtwork(items,{fetcher:async url=>{urls.push(url);const item=items.find(f=>artworkURL(f)===url);return {ok:true,arrayBuffer:async()=>files.get(item.path).slice().buffer};}});
  assert.deepEqual(downloaded,files);assert(urls.some(url=>url.includes('%23')));assert(urls.every(url=>url.startsWith('./gallery/')));
});
for(const fault of ['RADIO/radio.yml','MODELS/test.png','SCRIPTS/RF2/test.png','IMAGES/../test.png','IMAGES/sub/test.png','IMAGES/Wallpapers/../../test.png','IMAGES/test.lua','IMAGES/.hidden.png','IMAGES/CON.png','IMAGES/a:b.png','IMAGES/a\\b.png'])test('reject unsafe artwork path: '+fault,async()=>{
  const {catalog}=await collection();assert.throws(()=>validateArtwork([{...catalog.items[0],path:fault}]));
});
test('reject duplicate case aliases, invalid dimensions, size limits and remote catalog filenames',async()=>{
  const {catalog}=await collection(),item=catalog.items[0];
  assert.throws(()=>validateArtwork([item,{...item,id:'alias',path:item.path.toLowerCase()}]),/Duplicate/);
  for(const change of [{size:0},{size:17*1024*1024},{sha256:'oops'},{width:99999},{file:'https://host/x.png'},{id:'wrong'}])assert.throws(()=>validateCatalog({schema:1,items:[{...item,...change}]}));
  assert.throws(()=>validateArtwork(Array.from({length:9},(_,i)=>({...item,id:''+i,path:'IMAGES/'+i+'.png',size:16*1024*1024}))),/128 MB/);
});
for(const fault of ['http','hash','png','dimensions','cancel'])test('bad artwork never produces a usable payload: '+fault,async()=>{
  const {catalog}=await collection(),item={...catalog.items[0]};let bytes=png.slice();
  if(fault==='hash')bytes[33]^=1;
  if(fault==='png'){bytes[0]=0;item.sha256=await sha256(bytes);}
  if(fault==='dimensions')item.width=800;
  await assert.rejects(loadArtwork([item],{cancel:()=>fault==='cancel',fetcher:async()=>({ok:fault!=='http',arrayBuffer:async()=>bytes.buffer})}));
});
test('missing collection fails clearly; no selection requires no network',async()=>{
  await assert.rejects(loadCatalog(async()=>({ok:false})),/continue without images/);
  assert.deepEqual(await loadArtwork([],{fetcher:()=>{throw Error('must not fetch');}}),new Map());
});
test('release-name collisions get a separate destination and duplicate gallery content is copied once',async()=>{
  const {catalog}=await collection(),f=await makeDemo(),a=catalog.items[1];
  f.manifest.files.push({path:a.path,sha256:'f'.repeat(64)});
  const selected=selectArtwork(f.manifest,[a,{...a,id:'startup-screens/'+a.file,group:'startup-screens'}]);
  assert.equal(selected.length,1);assert.notEqual(selected[0].path,a.path);assert.match(selected[0].path,/KSE-[a-f0-9]+\.png$/);
  assert.throws(()=>new Installer({...f,artwork:[a]}),/conflicts/);
});
for(const skip of [false,true])test('all selected artwork copies before UF2 and passes final readback; skip backup='+skip,async()=>{
  const f=await fixture({skip}),before=await snapshot(f.sd);await f.engine.install();assert.equal(f.boot.writes.length,0);
  for(const item of f.artwork)assert.deepEqual(await f.sd.read(item.path),f.files.get(item.path));
  await f.engine.copyFirmware();await f.engine.verifyFinal({reconnected:true});assert.equal(f.engine.journal.verification.installedFiles,7);
  for(const path of ['RADIO/radio.yml','MODELS/model1.yml','SCRIPTS/RF2/settings.lua','IMAGES/My helicopter.png'])assert.equal(await sha256(await f.sd.read(path)),before[path]);
  if(skip)assert.equal(f.backup.writes.length,0);
});
test('selected existing images replace only their case-matched targets; originals are backed up and restored',async()=>{
  const f=await fixture({existing:true}),before=await snapshot(f.sd);await f.engine.install();
  for(const item of f.artwork){assert.deepEqual(await f.sd.read(item.path.toLowerCase()),f.files.get(item.path));assert.equal(await sha256(await f.backup.read('SD/'+item.path.toLowerCase())),before[item.path.toLowerCase()]);}
  await new Installer(f).restore();assert.deepEqual(await snapshot(f.sd),before);
});
test('any failed SD mutation rolls back both new and replaced artwork before firmware',async t=>{
  for(const existing of [false,true]){
    const prepared=await fixture({existing});
    for(let position=0;position<prepared.engine.plan.length;position++)await t.test('existing='+existing+' position='+position,async()=>{
      const f=await fixture({existing}),before=await snapshot(f.sd);let calls=0;f.sd.fail=()=>{if(calls++===position)throw Error('disconnect');};
      await assert.rejects(f.engine.install(),/restored and verified/);assert.deepEqual(await snapshot(f.sd),before);assert.equal(f.boot.writes.length,0);
    });
  }
});
test('changed artwork source prevents all SD and firmware writes',async()=>{
  const f=await fixture();f.files.set(f.artwork[0].path,encode('corrupt'));await assert.rejects(f.engine.install(),/Package changed/);assert.equal(f.sd.writes.length,0);assert.equal(f.boot.writes.length,0);
});
test('post-install artwork corruption prevents firmware copy, and final readback checks repaired artwork',async()=>{
  const f=await fixture();await f.engine.install();const item=f.artwork[0];f.sd.files.set(item.path,encode('corrupt'));
  await assert.rejects(f.engine.copyFirmware(),/changed/);assert.equal(f.boot.writes.length,0);f.sd.files.set(item.path,f.files.get(item.path));await f.engine.copyFirmware();
  f.sd.files.set(item.path,encode('corrupt'));await assert.rejects(f.engine.verifyFinal({reconnected:true}),/Installed file differs/);
  f.sd.files.set(item.path,f.files.get(item.path));await f.engine.verifyFinal({reconnected:true});
});
test('saved journal requires the same trusted selection; it cannot authorize another image path',async()=>{
  const f=await fixture(),j=structuredClone(f.engine.journal);
  const missing=new Installer({...f,artwork:[]});missing.journal=j;await assert.rejects(missing.install(),/same verified artwork/);
  j.artwork[0].path='IMAGES/Someone else.png';f.backup.files.set(JOURNAL,encode(JSON.stringify(j)));
  await assert.rejects(new Installer(f).restore(),/same verified artwork/);assert.equal(f.sd.writes.length,0);
});
test('saved SD-verified artwork resumes firmware and final verification without downloading or recopying artwork',async()=>{
  const f=await fixture();await f.engine.install();const writes=f.sd.writes.length;
  const next=new Installer({...f,files:new Map([...f.files].filter(([p])=>!p.startsWith('IMAGES/')))});
  await next.copyFirmware();await next.verifyFinal({reconnected:true});assert.equal(f.sd.writes.length,writes);assert.equal(next.journal.phase,'verified');
  assert.equal(artworkIdentity(next.journal.artwork),artworkIdentity(f.artwork));
});
