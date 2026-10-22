import test from 'node:test'
import {createRequire} from 'node:module'
const DateTime=createRequire(new URL('../vendor/t3code/apps/server/package.json',import.meta.url))('effect/DateTime')
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreferences } from '../agent-demo/t3-adapters/preferences.mjs'
const epoch = Date.parse('2026-10-21T10:00:00Z')
const shell = (extra={}) => ({id:'shared',projectId:'p',status:'completed',archivedAt:'legacy-other-user',pinnedAt:'legacy-other-user',activeRunId:null,pendingRuntimeRequest:null,updatedAt:new Date(epoch-1000).toISOString(),latestRunCompletedAt:new Date(epoch-2000).toISOString(),...extra})
function fixture(t,options={}) { const db=new DatabaseSync(':memory:'); const prefs=createPreferences({db,now:()=>epoch,...options}); t.after(()=>{prefs.dispose();db.close()}); let seq=0; return {prefs,run:(actor,type,extra={},thread=shell())=>prefs.applyCommand(actor,{type,threadId:'shared',commandId:`cmd${++seq}`,...extra},{thread,nativeSequence:73})} }
test('personal flags never inherit native shared flags and never modify shared run state',t=>{
 const {prefs,run}=fixture(t); const native=shell(); assert.equal(prefs.overlayThread('a',native).pinnedAt,null);
 run('a','thread.pin',{orderKey:'a0'}); run('a','thread.visit',{visitedAt:new Date(epoch).toISOString()});
 const a=prefs.overlayThread('a',native), b=prefs.overlayThread('b',native);
 assert.ok(a.pinnedAt); assert.equal(b.pinnedAt,null); assert.equal(b.lastVisitedAt,null); assert.equal(native.pinnedAt,'legacy-other-user'); assert.equal(a.updatedAt,native.updatedAt);
 run('a','thread.archive'); const snap={snapshotSequence:73,threads:[native],archivedThreads:[]};
 assert.equal(prefs.overlayShell('a',snap).threads.length,0); assert.equal(prefs.overlayShell('b',snap).threads.length,1);
 assert.equal(prefs.overlayShell('a',snap,{location:'archive'}).threads[0].id,'shared');
});
test('receipts persist across restarts and never invent native watermarks',t=>{
 const dir=mkdtempSync(join(tmpdir(),'t3-prefs-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'data.sqlite');
 let db=new DatabaseSync(path), prefs=createPreferences({db,now:()=>epoch});
 const command={type:'thread.pin',commandId:'retry',threadId:'shared'}; const result=prefs.applyCommand('a',command,{thread:shell(),nativeSequence:73});
 prefs.dispose();db.close(); db=new DatabaseSync(path);prefs=createPreferences({db});t.after(()=>{prefs.dispose();db.close()});
 assert.equal(prefs.overlayThread('a',shell()).pinnedAt,new Date(epoch).toISOString());
 assert.deepEqual(prefs.applyCommand('a',command,{thread:shell(),nativeSequence:80}),result);assert.equal(result.sequence,73); assert.equal(prefs.revision('a'),1);
 assert.throws(()=>prefs.applyCommand('a',{...command,type:'thread.unpin'},{thread:shell(),nativeSequence:80}),{code:'PREFERENCE_COMMAND_CONFLICT'});
});
test('all actor devices receive private changes and another actor never does',t=>{
 const {prefs,run}=fixture(t),a=[],a2=[],b=[]; const stop=prefs.subscribe('a',v=>a.push(v));prefs.subscribe('a',v=>a2.push(v));prefs.subscribe('b',v=>b.push(v));
 run('a','thread.pin');assert.equal(a.length,1);assert.equal(a2.length,1);assert.equal(b.length,0);stop();run('a','thread.unpin');assert.equal(a.length,1);assert.equal(a2.length,2);
});
test('settle guards shared active and queued runs, clears only personal pin/snooze',t=>{
 const {prefs,run}=fixture(t);run('a','thread.pin');
 assert.throws(()=>run('a','thread.settle',{},shell({hasQueuedUserRun:true})),{code:'THREAD_BUSY'});
 assert.throws(()=>run('a','thread.settle',{},shell({activityRunStatus:'running'})),{code:'THREAD_BUSY'});
 run('a','thread.snooze',{snoozedUntil:new Date(epoch+30000).toISOString()});run('a','thread.settle');
 const settled=prefs.overlayThread('a',shell());assert.equal(settled.settledOverride,'settled');assert.equal(settled.pinnedAt,null);assert.equal(settled.snoozedUntil,null);
 assert.equal(prefs.overlayThread('b',shell()).settledAt,null);
});
test('reorders cannot resurrect unpinned or settled threads; archive must restore first',t=>{
 const {prefs,run}=fixture(t); assert.throws(()=>run('a','thread.pin.reorder',{orderKey:'a1'}),{code:'THREAD_NOT_PINNED'});
 run('a','thread.pin');run('a','thread.pin.reorder',{orderKey:'a1'});assert.equal(prefs.overlayThread('a',shell()).pinOrderKey,'a1');
 assert.throws(()=>run('a','thread.active.reorder',{orderKey:'a2'}),{code:'THREAD_NOT_ACTIVE'});
 run('a','thread.archive');assert.throws(()=>run('a','thread.settle'),{code:'THREAD_ARCHIVED'});run('a','thread.unarchive');assert.equal(prefs.overlayThread('a',shell()).archivedAt,null);
});
test('read is monotonic and mark unread uses exact last completion minus one millisecond',t=>{
 const {prefs,run}=fixture(t);run('a','thread.visit',{visitedAt:new Date(epoch).toISOString()});run('a','thread.visit',{visitedAt:new Date(epoch-1000).toISOString()});
 assert.equal(prefs.overlayThread('a',shell()).lastVisitedAt,new Date(epoch).toISOString());run('a','thread.mark-unread');assert.equal(prefs.overlayThread('a',shell()).lastVisitedAt,new Date(epoch-2001).toISOString());
 assert.throws(()=>run('a','thread.mark-unread',{},shell({latestRunCompletedAt:null})),{code:'NO_COMPLETED_RUN'});
});
test('snooze expiry persists, privately notifies and returns native-compatible DateTime',async t=>{
 const {prefs,run}=fixture(t,{now:Date.now,decodeTimestamp:value=>({epochMillis:Date.parse(value)})});const changes=[];prefs.subscribe('a',v=>changes.push(v));
 run('a','thread.snooze',{snoozedUntil:new Date(Date.now()+60).toISOString()});assert.equal(typeof prefs.overlayThread('a',shell()).snoozedUntil.epochMillis,'number');
 await new Promise(r=>setTimeout(r,110));assert.equal(prefs.overlayThread('a',shell()).snoozedUntil,null);assert.ok(prefs.overlayThread('a',shell()).lastSnoozeWakeAt);assert.equal(changes.length,2);
});
test('failure or pending request wakes snooze; normal completion does not',t=>{
 const {prefs,run}=fixture(t);run('a','thread.snooze',{snoozedUntil:new Date(epoch+60000).toISOString()});
 assert.ok(prefs.overlayThread('a',shell({latestRunCompletedAt:new Date(epoch+1).toISOString()})).snoozedUntil);
 assert.equal(prefs.overlayThread('a',shell({status:'failed',latestRunCompletedAt:new Date(epoch+1).toISOString()})).snoozedUntil,null);
 assert.equal(prefs.overlayThread('a',shell({pendingRuntimeRequest:{id:'q'}})).snoozedUntil,null);
});
test('new authored message wakes settled state; projection preserves native run arrays',t=>{
 const {prefs,run}=fixture(t);run('a','thread.settle');const runs=[{status:'completed',completedAt:new Date(epoch).toISOString()}],runtimeRequests=[],messages=[{role:'user',createdAt:new Date(epoch+1000).toISOString()}];
 const result=prefs.overlayProjection('a',{thread:shell(),runs,runtimeRequests,messages});assert.equal(result.thread.settledAt,null);assert.equal(result.runs,runs);assert.equal(result.messages,messages);assert.equal(result.runtimeRequests,runtimeRequests);
});
test('automatic settlement loses to user pin and newer native snapshot',t=>{
 const {run}=fixture(t);run('a','thread.pin');assert.throws(()=>run('a','thread.auto-settle',{snapshotAt:new Date(epoch).toISOString()}),{code:'STALE_AUTO_SETTLEMENT'});
 assert.throws(()=>run('b','thread.auto-settle',{snapshotAt:new Date(epoch-5000).toISOString()}),{code:'STALE_AUTO_SETTLEMENT'});
});

test('real Effect DateTime survives visit then pin/settle/snooze/archive round trips',t=>{
 const {prefs,run}=fixture(t,{decodeTimestamp:DateTime.makeUnsafe})
 run('a','thread.visit',{visitedAt:DateTime.makeUnsafe(epoch)})
 run('a','thread.pin')
 assert.equal(DateTime.toEpochMillis(prefs.overlayThread('a',shell()).pinnedAt),epoch)
 run('a','thread.unpin');run('a','thread.settle');run('a','thread.unsettle')
 run('a','thread.snooze',{snoozedUntil:new Date(epoch+60000).toISOString()})
 assert.equal(DateTime.toEpochMillis(prefs.overlayThread('a',shell()).snoozedUntil),epoch+60000)
 run('a','thread.unsnooze');run('a','thread.archive');run('a','thread.unarchive');run('a','thread.mark-unread')
 assert.equal(DateTime.toEpochMillis(prefs.overlayThread('a',shell()).lastVisitedAt),epoch-2001)
 assert.equal(prefs.overlayThread('b',shell()).lastVisitedAt,null)
})
