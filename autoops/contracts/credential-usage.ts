import * as S from 'effect/Schema'
import { DirectoryId } from './project-directory.ts'

const Name = S.String.check(S.isMinLength(1), S.isMaxLength(200))
const References = <T extends S.Constraint>(schema: T) => S.Array(schema).check(S.isMaxLength(1000))

/** 当前配置的授权引用；不包含秘密、仓库地址、历史输入或构建配置。 */
export const CredentialUsage = S.Struct({
  projectId: DirectoryId,
  credentialId: DirectoryId,
  repositories: References(S.Struct({ id: DirectoryId, name: Name })),
  workspaces: References(
    S.Struct({
      repositoryId: DirectoryId,
      mountPath: S.String.check(S.isMinLength(1), S.isMaxLength(800)),
    }),
  ),
  services: References(
    S.Struct({
      serviceId: DirectoryId,
      serviceName: Name,
      environmentId: DirectoryId,
      environmentName: Name,
      repositoryIds: S.Array(DirectoryId).check(S.isMaxLength(32)),
    }),
  ),
  connections: References(
    S.Struct({
      connectionId: DirectoryId,
      name: Name,
      type: S.Literals(['server', 'mysql', 'redis']),
      environmentId: DirectoryId,
      environmentName: Name,
      enabled: S.Boolean,
    }),
  ),
})
export type CredentialUsage = typeof CredentialUsage.Type
