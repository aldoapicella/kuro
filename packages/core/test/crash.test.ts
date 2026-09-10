import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { decodeWire,digestBytes } from '@kuro/contracts';

async function child(file:string,args:string[]){
  const processChild=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL(file,import.meta.url)),...args],{stdio:['ignore','pipe','pipe']});
  let out='',err='';processChild.stdout.on('data',chunk=>out+=String(chunk));processChild.stderr.on('data',chunk=>err+=String(chunk));
  const timer=setTimeout(()=>processChild.kill('SIGKILL'),15000);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>processChild.on('exit',(code,signal)=>resolve({code,signal})));
  clearTimeout(timer);return {...result,out,err};
}
for(const phase of ['approval_before','approval_after','receipt_before','receipt_after','search_running','index_running']){
  test(`independent process SIGKILL/reopen at ${phase}`,async()=>{
    const directory=mkdtempSync(join(tmpdir(),'kuro-crash-'));
    try{
      const died=await child('crash-child.ts',[phase,directory]);assert.equal(died.signal,'SIGKILL',died.err);
      const reopened=await child('reopen-child.ts',[directory]);assert.equal(reopened.code,0,reopened.err);
      const owner=new DatabaseSync(join(directory,'owner.sqlite'));const requester=new DatabaseSync(join(directory,'requester.sqlite'));
      try{
        const approvals=owner.prepare('SELECT * FROM approvals').all();const outbox=owner.prepare('SELECT * FROM outbox').all();const inbox=requester.prepare('SELECT * FROM inbox').all();
        if(phase==='approval_before'){assert.equal(approvals.length,0);assert.equal(outbox.length,0);}
        if(phase==='approval_after'){assert.equal(approvals.length,1);assert.equal(outbox.length,1);const bytes=approvals[0]!.bytes as Uint8Array;assert.equal(digestBytes(bytes),approvals[0]!.digest);assert.equal(decodeWire(bytes).type,'APPROVED_RESPONSE');}
        if(phase==='receipt_before')assert.equal(inbox.length,0);
        if(phase==='receipt_after'){assert.equal(inbox.length,1);assert.notEqual(outbox[0]!.state,'ACKED');}
        if(phase==='search_running'){assert.equal(owner.prepare("SELECT count(*) n FROM requests WHERE state='RETRIEVING'").get()!.n,0);assert.equal(owner.prepare('SELECT count(*) n FROM reviews').get()!.n,0);}
        if(phase==='index_running'){assert.equal(owner.prepare("SELECT count(*) n FROM index_generations WHERE state='PENDING'").get()!.n,0);assert.equal(owner.prepare("SELECT count(*) n FROM documents WHERE ingestion_state='PENDING'").get()!.n,0);}
        assert.equal(owner.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(requester.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
      }finally{owner.close();requester.close();}
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
}
