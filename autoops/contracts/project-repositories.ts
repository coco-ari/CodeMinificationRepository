import * as S from 'effect/Schema'
import { DirectoryCommand, DirectoryId } from './project-directory.ts'

export const RepositoryDetails = S.Struct({
  name: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
  url: S.String.check(S.isMinLength(1), S.isMaxLength(2000)),
  credentialId: S.optionalKey(DirectoryId),
})
export const SaveRepository = S.Struct({ ...DirectoryCommand.fields, value: RepositoryDetails })
export const ConfigureRepositoryWorkspace = S.Struct({
  ...DirectoryCommand.fields,
  id: DirectoryId,
  role: S.Literals(['frontend', 'backend', 'shared', 'documentation', 'other']),
  refKind: S.Literals(['default', 'branch', 'tag', 'commit']),
  ref: S.String.check(S.isMaxLength(200)),
  mountPath: S.String.check(S.isMinLength(1), S.isMaxLength(800)),
  sourcePath: S.optionalKey(S.String.check(S.isMaxLength(800))),
})
