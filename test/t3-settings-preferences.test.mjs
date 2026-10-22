import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createSettingsPreferences,assertPersonalSettingsPatch} from '../agent-demo/t3-adapters/settings-preferences.mjs'
test('personal settings isolate actors, merge concurrent scalars and never persist provider authority', () => {
 const db=new DatabaseSync(':memory:'); const a=createSettingsPreferences({db}), b=createSettingsPreferences({db})
 let changes=0, other=0; a.subscribe('admin',()=>changes++);a.subscribe('lin',()=>other++)
 a.update('admin',{responseStreamingMode:'turn'}); b.update('admin',{autoResumeLimitedThreads:false})
 assert.deepEqual(a.read('admin'),{responseStreamingMode:'turn',autoResumeLimitedThreads:false})
 assert.equal(changes,1);assert.equal(other,0)
 assert.equal(a.overlay('lin',{responseStreamingMode:'paragraph'}).responseStreamingMode,'paragraph')
 assert.throws(()=>a.update('admin',{providerInstances:{codex:{command:'sh'}}}))
 assert.throws(()=>a.update('admin',{projectSettingsOverrides:{p:{defaultRuntimeMode:'full-access'}}}))
 assert.throws(()=>assertPersonalSettingsPatch({responseStreamingMode:'token'}))
 assert.throws(()=>assertPersonalSettingsPatch({compactIdleThreads:'false'}))
 assert.throws(()=>assertPersonalSettingsPatch({sidebarAutoSettleAfterDays:-1}))
 assert.equal(a.read('admin').responseStreamingMode,'turn');db.close()
})
