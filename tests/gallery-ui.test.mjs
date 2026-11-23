import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=name=>readFileSync(new URL('../gallery/'+name,import.meta.url),'utf8');
const element=(extra={})=>({hidden:false,textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},dispatchEvent(event){this.listeners[event.type]?.(event);},...extra});

test('gallery searches every collection, announces empty results and resets on category navigation',()=>{
  const search=element({value:''}),matches=element(),nav=element();
  const cards=['blue wallpaper','nimbus blue purple','canada startup'].map(name=>element({dataset:{search:name}}));
  const sections=cards.map(card=>element({querySelectorAll:()=>[card]}));
  vm.runInNewContext(script('gallery.js'),{Event:class{constructor(type){this.type=type;}},document:{getElementById:id=>({search,matches})[id],querySelectorAll:selector=>selector==='[data-collection]'?sections:[nav]}});
  search.value='  BLUE ';search.dispatchEvent({type:'input'});
  assert.equal(matches.textContent,'2 images found');assert.deepEqual(cards.map(c=>c.hidden),[false,false,true]);
  search.value='unmatched';search.dispatchEvent({type:'input'});
  assert.equal(matches.textContent,'No images match your search.');assert(sections.every(s=>s.hidden));
  nav.dispatchEvent({type:'click'});assert.equal(search.value,'');assert.equal(matches.hidden,true);assert(cards.every(c=>!c.hidden));
});

test('image previews change model pairing and switch between dashboard and startup views',()=>{
  const hidden=new Set();
  const pair=element({value:'../../model-images/Nimbus.png',dataset:{pairTarget:'model-image'},selectedOptions:[{dataset:{modelName:'Nimbus'}}],options:[{}]});
  const image={setAttribute(k,v){this[k]=v;}},boot=element({checked:false}),mode=element();
  const nodes={pair,'model-image':image,'model-name':element(),boot,dashboard:{classList:{toggle(name,on){if(on)hidden.add(name);else hidden.delete(name);}}},'pair-setting':element(),'screen-title':element(),caption:element()};
  vm.runInNewContext(script('preview.js'),{document:{getElementById:id=>nodes[id],querySelectorAll:()=>[boot,mode]}});
  pair.dispatchEvent({type:'change'});assert.equal(image.href,pair.value);assert.equal(nodes['model-name'].textContent,'Nimbus');
  boot.checked=true;boot.dispatchEvent({type:'change'});assert(hidden.has('is-hidden'));assert.equal(nodes['pair-setting'].hidden,true);assert.equal(nodes['screen-title'].textContent,'Startup screen preview');
  boot.checked=false;mode.dispatchEvent({type:'change'});assert.equal(hidden.size,0);assert.equal(nodes['pair-setting'].hidden,false);
  pair.options=[];mode.dispatchEvent({type:'change'});assert.equal(nodes['pair-setting'].hidden,true);
});
