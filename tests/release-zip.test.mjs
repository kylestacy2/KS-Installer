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

test('a release ZIP of the right size but changed contents is rejected',async()=>{
  const forged=new Blob([new Uint8Array(manifest.zip.size)]);
  await assert.rejects(loadRelease(forged,manifest),/checksum does not match/);
});
