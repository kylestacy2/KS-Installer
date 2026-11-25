import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from '../core.js';

// Releases since 23 November supply a compatible Flight Modifier. The plan must
// treat it like any other release file, never as the legacy tool to delete.
const path='SCRIPTS/TOOLS/Flight Modifier.lua';
const current='b'.repeat(64);
const manifest={
  files:[{path,size:10,sha256:current}],
  settings:{path:'SCRIPTS/RF2/settings.lua',size:10,sha256:'c'.repeat(64)},
};
const settings={'SCRIPTS/RF2/settings.lua':{sha256:'d'.repeat(64),size:10}};
const ops=before=>buildPlan(manifest,{...settings,...before}).operations.filter(op=>op.path.startsWith(path));

test('an up-to-date Flight Modifier is kept, not deleted', ()=>{
  assert.deepEqual(ops({[path]:{sha256:current,size:10}}),[]);
});
test('an older Flight Modifier is updated once, with no duplicate operation', ()=>{
  assert.deepEqual(ops({[path]:{sha256:'a'.repeat(64),size:9}}).map(op=>[op.operation,op.after]),[['update',current]]);
});
test('a missing Flight Modifier is added', ()=>{
  assert.deepEqual(ops({}).map(op=>op.operation),['add']);
});
test('stale Flight Modifier bytecode is still removed', ()=>{
  assert.deepEqual(ops({[path]:{sha256:current,size:10},[path+'c']:{sha256:'e'.repeat(64),size:5}}).map(op=>[op.path,op.operation]),[[path+'c','remove']]);
});
test('the legacy tool is still removed when a release does not supply it', ()=>{
  const plan=buildPlan({...manifest,files:[]},{...settings,[path]:{sha256:'a'.repeat(64),size:9}});
  assert.deepEqual(plan.operations.filter(op=>op.path===path).map(op=>op.operation),['remove']);
});
