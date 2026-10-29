import * as S from 'effect/Schema'
import { DirectoryId } from './project-directory.ts'

export const NodeCommand = S.Struct({ requestId: DirectoryId })
export const RegisterDeploymentNode = S.Struct({
  ...NodeCommand.fields,
  name: S.String.check(S.isMinLength(1), S.isMaxLength(80)),
})
export const DeploymentNodePolicy = S.Struct({
  ...NodeCommand.fields,
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
  retainedVersions: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  buildCacheGiB: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
})
export const DeploymentNodeProjectAccess = S.Struct({
  ...NodeCommand.fields,
  allowed: S.Boolean,
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
})
export const AssignDeploymentNode = S.Struct({
  ...NodeCommand.fields,
  projectId: DirectoryId,
  environmentIds: S.Array(DirectoryId).check(S.isMaxLength(50)),
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
})
