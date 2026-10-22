import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {once} from 'node:events'

test('only the T3 host page permits same-origin native PDF embeds', async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'t3-host-csp-'));const staticDir=path.join(root,'static');await mkdir(staticDir);await writeFile(path.join(staticDir,'agent-demo.html'),'<!doctype html><title>T3 fixture</title>');await writeFile(path.join(staticDir,'other.html'),'<!doctype html><title>Other fixture</title>');
 try{for(const mode of ['t3','legacy']){
  const child=spawn(process.execPath,['agent-demo/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:path.join(root,mode),STATIC_DIR:staticDir,AGENT_DEMO_ENGINE:mode},stdio:['ignore','pipe','pipe']});let logs='';const exited=once(child,'exit');
  try{const address=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('server start timeout: '+logs)),10000);child.stdout.on('data',chunk=>{logs+=chunk;const match=logs.match(/Agent Demo listening (\{[^\n]+?\}); data=/);if(match){clearTimeout(timeout);resolve(JSON.parse(match[1]))}});child.stderr.on('data',chunk=>{logs+=chunk});child.once('error',reject)});
   for(const pathname of ['/','/agent-demo.html','/other.html']){const response=await fetch(`http://127.0.0.1:${address.port}${pathname}`);assert.equal(response.status,200);const csp=response.headers.get('content-security-policy');const allowed=mode==='t3'&&pathname!=='/other.html';assert(csp.includes(`object-src '${allowed?'self':'none'}'`));assert(csp.includes("script-src 'self'"));assert(csp.includes("frame-ancestors 'none'"));assert(!csp.includes('object-src *'));}
  }finally{child.kill('SIGTERM');await exited}
 }}finally{await rm(root,{recursive:true,force:true})}
})
