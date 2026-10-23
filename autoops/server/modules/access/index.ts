import type { DatabaseSync } from 'node:sqlite'
import type {
  AuditWriter,
  IdentityReader,
  ProjectDirectory,
  Runtime,
  Transaction,
} from '../../platform/ports.ts'
import { repository } from './sqlite.ts'
import { createAccessService } from './service.ts'
export { migration } from './sqlite.ts'
export type { AccessService } from './service.ts'
export const createAccess = (
  db: DatabaseSync,
  identity: IdentityReader,
  directory: ProjectDirectory,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
) => createAccessService(repository(db), identity, directory, tx, audit, runtime)
