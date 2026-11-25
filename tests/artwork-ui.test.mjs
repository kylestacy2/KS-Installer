import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Installer} from '../core.js';
import {artworkURL} from '../artwork.js';
import {collection} from './artwork-fixture.mjs';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('../release.json',import.meta.url)));
const element=()=>({disabled:false,hidden:false,checked:false,open:false,value:'',textContent:'',children:[],classList:{toggle(){}},focus(){document.activeElement=this;},scrollIntoView(){},append(x){this.children.push(x);},replaceChildren(){this.children=[];},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();}});
let sequence=0;
async function setup(){
  const assets=await collection(),nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element()])),requests=[];
  globalThis.document={getElementById:id=>{assert(nodes[id],id);return nodes[id];},createElement:element};
  globalThis.window={addEventListener(){}};
  globalThis.isSecureContext=true;
  const state={nodes,assets,requests,catalogFailure:false,imageFailure:false,engine:null};
  globalThis.fetch=async url=>{
    requests.push(url);
    if(url==='./release.json')return Response.json(manifest);
    if(url.endsWith('catalog.json'))return {ok:!state.catalogFailure,json:async()=>assets.catalog};
    const item=assets.catalog.items.find(item=>artworkURL(item)===url);assert(item,url);
    return {ok:!state.imageFailure,arrayBuffer:async()=>assets.files.get(item.path).slice().buffer};
  };
  const timer=globalThis.setTimeout;globalThis.setTimeout=(...args)=>{const t=timer(...args);t.unref();return t;};
  await import('../app.js?artwork-ui-'+sequence++);
  state.click=async id=>{
    assert(!nodes[id].disabled,id+' enabled');const scan=Installer.prototype.scan;
    Installer.prototype.scan=async function(...args){state.engine=this;return scan.apply(this,args);};
    try{await nodes[id].onclick();}finally{Installer.prototype.scan=scan;}
  };
  state.select=(position,checked=true)=>{const input=nodes['artwork-grid'].children[position].children[0];assert(!input.disabled);input.checked=checked;input.onchange();};
  await state.click('demo');return state;
}

test('the optional section never fetches artwork or blocks the default install',async()=>{
  const f=await setup();assert.match(f.nodes['artwork-summary'].textContent,/No extra/);
  await f.click('continue-artwork');assert.equal(document.activeElement,f.nodes['step-radio-heading']);assert.equal(f.nodes['step-artwork'].open,false);
  for(const id of ['scan','backup','install','demo-reconnect','verify'])await f.click(id);
  assert.equal(f.nodes['completion-title'].textContent,'Demo complete!');assert.equal(f.nodes['artwork-after-install'].hidden,true);
  assert(f.requests.every(url=>url.endsWith('release.json')));
});
test('choose all categories, filter, copy before firmware and display completion guidance',async()=>{
  const f=await setup();await f.click('choose-artwork');assert.equal(f.nodes['artwork-grid'].children.length,3);
  for(let i=0;i<3;i++)f.select(i);assert.match(f.nodes['artwork-summary'].textContent,/3 images selected/);
  f.nodes['artwork-search'].value='helicopter';f.nodes['artwork-search'].oninput();assert.equal(f.nodes['artwork-results'].textContent,'1 images shown');
  f.nodes['artwork-search'].value='';f.nodes['artwork-category'].value='wallpapers';f.nodes['artwork-category'].onchange();assert.equal(f.nodes['artwork-grid'].children[0].hidden,true);assert.equal(f.nodes['artwork-grid'].children[1].hidden,false);
  await f.click('scan');assert.match(f.nodes['plan-summary'].textContent,/8 file changes/);assert.equal(f.engine.sd.writes.length,0);
  await f.click('backup');assert.equal(f.nodes['choose-artwork'].disabled,true);assert.equal(f.nodes['continue-artwork'].disabled,true);assert.equal(f.nodes['clear-artwork'].disabled,true);assert(f.nodes['artwork-grid'].children.every(card=>card.children[0].disabled));
  await f.click('install');for(const [path,bytes] of f.assets.files)assert.deepEqual(await f.engine.sd.read(path),bytes);
  await f.click('demo-reconnect');await f.click('verify');assert.equal(f.nodes['artwork-after-install'].hidden,false);assert.match(f.nodes['final-result'].textContent,/7 installed SD files/);
});
test('changing or clearing artwork invalidates a previous scan and requires a new preview',async()=>{
  const f=await setup();await f.click('choose-artwork');await f.click('scan');assert(!f.nodes.backup.disabled);
  f.select(0);assert(f.nodes.backup.disabled);assert(f.nodes['skip-backup'].disabled);assert(f.nodes.plan.hidden);
  await f.click('scan');assert(!f.nodes.backup.disabled);await f.click('clear-artwork');assert(f.nodes.backup.disabled);assert.match(f.nodes['artwork-summary'].textContent,/No extra/);
  await f.click('scan');assert.match(f.nodes['plan-summary'].textContent,/5 file changes/);
});
test('unavailable collection does not prevent installing without artwork',async()=>{
  const f=await setup();f.catalogFailure=true;await f.click('choose-artwork');assert.match(f.nodes.message.textContent,/continue without images/);
  for(const id of ['scan','backup','install','demo-reconnect','verify'])await f.click(id);
  assert.equal(f.nodes['completion-dialog'].open,true);
});
test('failed selected-image download blocks backup and flashing until retried or cleared',async()=>{
  const f=await setup();await f.click('choose-artwork');f.select(0);f.imageFailure=true;await f.click('scan');
  assert.match(f.nodes.message.textContent,/Cannot download/);assert(f.nodes.backup.disabled);assert(f.nodes.install.disabled);assert.equal(f.engine,null);
  f.imageFailure=false;await f.click('scan');assert.equal(f.engine.sd.writes.length,0);assert(!f.nodes.backup.disabled);
});
test('skipped backup still includes selected images in installation and final checks',async()=>{
  const f=await setup();await f.click('choose-artwork');f.select(2);await f.click('scan');await f.click('skip-backup');await f.click('confirm-skip-backup');
  assert(f.nodes['clear-artwork'].disabled);await f.click('install');assert.equal(f.engine.backup.writes.length,0);
  await f.click('demo-reconnect');await f.click('verify');assert.equal(f.engine.journal.phase,'verified');assert.match(f.nodes['final-result'].textContent,/5 installed SD files/);
});

test('closed beta: the page offers no release download, only the private release ZIP',async()=>{
  assert(!html.includes('grab-latest'),'no automatic download button');
  assert(!('download' in manifest),'release.json has no public bundle');
  const f=await setup();
  assert.deepEqual(f.requests,['./release.json']);
});
