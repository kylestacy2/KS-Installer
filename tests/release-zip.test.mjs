import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadRelease} from '../zip.js';

const manifest=JSON.parse(await readFile(new URL('../release.json',import.meta.url)));

test('a ZIP from another release names the release the installer expects',async()=>{
  const other=new Blob([new Uint8Array(1024)]);
  await assert.rejects(loadRelease(other,manifest),error=>{
    assert.match(error.message,/different KSE Touch release/);
    assert(error.message.includes(manifest.label),'error names the expected release');
    return true;
  });
});

test('the pinned Grab latest bundle still loads through the manual path',async()=>{
  const bundle=new Blob([await readFile(new URL('../'+manifest.download.path,import.meta.url))]);
  const files=await loadRelease(bundle,{...manifest,zip:manifest.download});
  assert.equal(files.size,manifest.files.length+2);
});
