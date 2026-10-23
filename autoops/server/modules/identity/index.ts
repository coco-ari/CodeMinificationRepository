import type { DatabaseSync } from 'node:sqlite'
import type { AuditWriter, Authorization, Runtime, Transaction } from '../../platform/ports.ts'
import { repository } from './sqlite.ts'
import { secrets } from './secrets.ts'
import { createIdentityService } from './service.ts'
export { migration } from './sqlite.ts'
export type { IdentityService } from './service.ts'
export const createIdentity = (
  db: DatabaseSync,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
  auth: Authorization,
) => createIdentityService(repository(db), tx, audit, runtime, secrets, auth)
