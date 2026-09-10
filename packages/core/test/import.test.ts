import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,renameSync,symlinkSync,rmSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectedTextFiles } from '../src/index.js';
import { makeWorld,ok } from './world.js';

test('trusted selected-file identity rejects replacement and parent-link escapes',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'kuro-file-test-')));const selected=join(root,'selected');const outside=join(root,'outside');mkdirSync(selected);mkdirSync(outside);
  const source=join(selected,'source.txt');writeFileSync(source,'Selected snapshot');writeFileSync(join(outside,'source.txt'),'OUTSIDE_SENTINEL');
  const files=new SelectedTextFiles();try{
    const token=files.register(source);renameSync(selected,join(root,'old'));symlinkSync(outside,selected,'dir');
    await assert.rejects(files.read(token,10000));
    const path=join(outside,'source.txt');const replacement=files.register(path);renameSync(path,join(outside,'renamed.txt'));writeFileSync(path,'Different inode');await assert.rejects(files.read(replacement,10000));
    const good=files.register(path);assert.equal(new TextDecoder().decode((await files.read(good,1000)).bytes),'Different inode');await assert.rejects(files.read(good,1000));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid UTF-8 and oversized snapshots fail without storing documents; Unicode byte offsets remain exact',async()=>{
  const w=await makeWorld();try{
    for(const bytes of [new Uint8Array([0xff]),new Uint8Array(262145).fill(65)]){
      const result=await w.owner.core.app.importText({spaceId:w.spaceId,selectionId:w.owner.files.add(bytes),replaceDocumentId:null,expectedRevision:null,rules:w.rules});assert.equal(result.ok,false);
    }
    assert.equal(w.inspect('owner','SELECT count(*) n FROM documents')[0]!.n,0);
    const text='\uFEFFCafé 🌍\r\n';await w.importDoc(text);
    const stored=w.inspect('owner','SELECT bytes FROM versions')[0]!.bytes as Uint8Array;assert.deepEqual(Uint8Array.from(stored),new TextEncoder().encode(text));
    const span=w.inspect('owner','SELECT start_byte,end_byte,text FROM spans')[0]!;assert.equal(span.end_byte,new TextEncoder().encode(text).length);assert.equal(span.text,text);
  }finally{await w.close();}
});
test('unauthorized model profile change never contacts the AI adapter',async()=>{
  const w=await makeWorld();try{
    let called=0;const original=w.owner.ai.getCapabilities.bind(w.owner.ai);w.owner.ai.getCapabilities=async()=>{called++;return original();};
    w.owner.options.sessions.session=null;
    const result=await w.owner.core.app.setIndexProfile({spaceId:w.spaceId,profile:{modelId:'test',modelChecksum:'f'.repeat(64),dimension:2,normalization:'unit',segmentationVersion:'v1'},expectedRevision:0});
    assert.equal(result.ok,false);assert.equal(called,0);
  }finally{await w.close();}
});
