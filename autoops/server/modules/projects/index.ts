import type { DatabaseSync } from 'node:sqlite'
import type {
  AuditWriter,
  Authorization,
  IdentityReader,
  Runtime,
  Transaction,
} from '../../platform/ports.ts'
import { repository } from './sqlite.ts'
import { createProjectService } from './service.ts'
import type { MembershipAccess } from './domain.ts'
export { migration } from './sqlite.ts'
export function createProjects(
  db: DatabaseSync,
  auth: Authorization,
  access: MembershipAccess,
  identity: IdentityReader,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
) {
  const repo = repository(db)
  return {
    service: createProjectService(repo, auth, access, identity, tx, audit, runtime),
    directory: {
      exists: repo.exists,
      member: repo.member,
      creator: repo.creator,
      environmentProject: repo.environmentProject,
    },
  }
}
