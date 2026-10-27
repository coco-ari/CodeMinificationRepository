import * as S from 'effect/Schema'
import { DirectoryId } from './project-directory.ts'

const FilePath = S.String.check(S.isMinLength(1), S.isMaxLength(800))
export const WorkspaceFileReferenceRequest = S.Struct({
  threadId: DirectoryId,
  viewerThreadId: S.optional(DirectoryId),
  inputId: DirectoryId,
  path: FilePath,
  workspaceType: S.Literals(['internal', 'external']),
})
export type WorkspaceFileReferenceRequest = typeof WorkspaceFileReferenceRequest.Type
const fields = {
  projectId: DirectoryId,
  threadId: DirectoryId,
  viewerThreadId: DirectoryId,
  workspaceType: S.Literals(['internal', 'external']),
  originalInputId: DirectoryId,
  originalPath: FilePath,
  currentPath: FilePath,
  resourcePath: S.String.check(S.isMinLength(1), S.isMaxLength(2000)),
  revision: DirectoryId,
  sha256: S.String.check(S.isPattern(/^[a-f0-9]{64}$/)),
}
/** 普通文件当前定位与固定轮次读取分开；资源地址仍由服务端逐次授权。 */
export const WorkspaceFileReference = S.Union([
  S.Struct({ ...fields, mode: S.Literal('original'), changed: S.Literal(false) }),
  S.Struct({ ...fields, mode: S.Literal('current'), changed: S.Boolean }),
])
export type WorkspaceFileReference = typeof WorkspaceFileReference.Type
