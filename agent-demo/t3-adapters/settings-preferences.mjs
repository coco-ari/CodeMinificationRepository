import { resolveProductProfile, PRODUCT_CAPABILITY_DISABLED, PRODUCT_CAPABILITY_MESSAGE } from './product-profile.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

// These are the native scalar conversation settings. Runtime services resolve
// them using the thread owner; organization projections resolve the current actor.
export const personalSettingsKeys = Object.freeze([
  'responseStreamingMode', 'sidebarAutoSettleAfterDays', 'sidebarAutoSettleKeepPullRequests',
  'sidebarAutoSettleOnMerge', 'autoResumeLimitedThreads', 'snoozeLimitedThreads',
  'compactIdleThreads', 'continueThreadsAfterServerUpdate',
])
export function assertPersonalSettingsPatch(patch, env = process.env) {
  const overrides = resolveProductProfile(env).serverSettingsOverrides
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !personalSettingsKeys.includes(key)))
    throw new Error('Only personal conversation settings may be updated')
  for (const [key,value] of Object.entries(patch)) {
    if (Object.hasOwn(overrides, key) && value !== overrides[key]) throw Object.assign(new Error(PRODUCT_CAPABILITY_MESSAGE), {code: PRODUCT_CAPABILITY_DISABLED})
    if (key === 'responseStreamingMode') {
      if (!['paragraph','turn'].includes(value)) throw new Error('Invalid native streaming mode')
    } else if (key === 'sidebarAutoSettleAfterDays') {
      if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error('Invalid settlement interval')
    } else if (typeof value !== 'boolean') throw new Error('Invalid personal preference')
  }
}
export function createSettingsPreferences({db, env = process.env}) {
  db.exec('CREATE TABLE IF NOT EXISTS t3_user_settings (principal_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL)')
  const listeners = new Map()
  const read = (principalId) => JSON.parse(db.prepare('SELECT value_json FROM t3_user_settings WHERE principal_id=?').get(principalId)?.value_json ?? '{}')
  return {
    read,
    overlay(principalId,settings) { return {...settings,...read(principalId),...resolveProductProfile(env).serverSettingsOverrides} },
    update(principalId,patch) {
      assertPersonalSettingsPatch(patch, env)
      const fixed = resolveProductProfile(env).serverSettingsOverrides
      const editable = Object.fromEntries(Object.entries(patch).filter(([key]) => !Object.hasOwn(fixed, key)))
      if (!Object.keys(editable).length) return read(principalId)
      db.exec('BEGIN IMMEDIATE')
      try {
        const next={...read(principalId),...editable}
        db.prepare('INSERT INTO t3_user_settings VALUES(?,1,?) ON CONFLICT(principal_id) DO UPDATE SET revision=revision+1,value_json=excluded.value_json').run(principalId,JSON.stringify(next))
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      for (const notify of listeners.get(principalId) ?? []) notify()
      return read(principalId)
    },
    subscribe(principalId,listener) { let set=listeners.get(principalId); if (!set) listeners.set(principalId,set=new Set()); set.add(listener); return () => {set.delete(listener);if (!set.size) listeners.delete(principalId)} },
  }
}
let configured
export function configuredSettingsPreferences() {
  if (process.env.AUTOOPS_T3_DATA_DIR === undefined) return undefined
  if (!process.env.AUTOOPS_T3_DATA_DIR.trim()) throw new Error('AUTOOPS_T3_DATA_DIR must not be empty')
  if (!configured) {
    const directory=resolve(process.env.AUTOOPS_T3_DATA_DIR); mkdirSync(directory,{recursive:true,mode:0o700})
    const db=new DatabaseSync(join(directory,'t3-autoops.sqlite')); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    configured=createSettingsPreferences({db})
  }
  return configured
}
