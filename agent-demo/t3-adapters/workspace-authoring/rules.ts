// @effect-diagnostics nodeBuiltinImport:off -- 同步哈希与路径校验属于资料模块的 Node 输入边界。
import { createHash } from 'node:crypto'
import { extname, basename } from 'node:path'
import type {
  WorkspaceRepositorySource,
  ProjectRepositoryDetails,
  WorkspaceSourceInput,
} from '../../../autoops/contracts/workspace-authoring.ts'

export const limits = { maxFileBytes: 8 * 1024 * 1024, maxFiles: 12000, maxBytes: 64 * 1024 * 1024 }
export const parserVersion = 'business-documents-v1:officeparser-8.2.0'
export class WorkspaceAuthoringError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WorkspaceAuthoringError'
    this.status = status
    this.code = code
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new WorkspaceAuthoringError(status, code, message)
}
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value))
    fail(400, 'WORKSPACE_ID_INVALID', '对象标识无效')
  return value
}
export function requestIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_:\-]{0,159}$/.test(value))
    fail(400, 'WORKSPACE_REQUEST_ID_INVALID', '原请求标识无效')
  return value
}
export function path(value: unknown, allowRoot = false): string {
  if (allowRoot && value === '') return ''
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 800 ||
    /^[\/]/.test(value) ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
    /^(?:\.autoops|WORKSPACE\.md)(?:\/|$)/i.test(value)
  )
    fail(400, 'WORKSPACE_PATH_INVALID', '请选择项目内的有效相对路径，不能使用 Git 或平台元数据路径')
  return value.normalize('NFC')
}
export const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail(400, 'WORKSPACE_REVISION_INVALID', '需要有效的资料修订条件')
  return Number(value)
}
export function normalizeSource(
  input: WorkspaceSourceInput,
  sourceId: string,
): WorkspaceRepositorySource {
  if (!input || typeof input !== 'object') fail(400, 'WORKSPACE_SOURCE_INVALID', '仓库来源格式无效')
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 200 ||
    /[\x00-\x1f]/.test(input.name)
  )
    fail(400, 'WORKSPACE_SOURCE_INVALID', '请填写有效的仓库名称')
  if (!['frontend', 'backend', 'shared', 'documentation', 'other'].includes(input.role))
    fail(400, 'WORKSPACE_SOURCE_INVALID', '仓库用途无效')
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    return fail(400, 'WORKSPACE_SOURCE_INVALID', '请填写 HTTPS Git 地址')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.pathname === '/' ||
    /[\x00-\x20\\]/.test(input.url)
  )
    fail(400, 'WORKSPACE_SOURCE_INVALID', '仓库地址必须是无凭据和参数的 HTTPS 地址')
  if (!['default', 'branch', 'tag', 'commit'].includes(input.refKind))
    fail(400, 'WORKSPACE_REF_INVALID', '来源版本类型无效')
  const ref = input.refKind === 'default' ? '' : input.ref
  if (
    typeof ref !== 'string' ||
    ref.length > 200 ||
    (input.refKind !== 'default' &&
      (!ref ||
        /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref) ||
        ref.includes('..') ||
        ref.includes('@{') ||
        ref.startsWith('-') ||
        ref === '@' ||
        ref
          .split('/')
          .some(
            (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'),
          )))
  )
    fail(400, 'WORKSPACE_REF_INVALID', '分支或标签名称无效')
  if (input.refKind === 'commit' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref))
    fail(400, 'WORKSPACE_REF_INVALID', '请选择完整 Git 提交号')
  const mountPath = path(input.mountPath)
  if (['docs', 'prototypes'].some((directory) => overlaps(mountPath, directory)))
    fail(409, 'WORKSPACE_MOUNT_CONFLICT', 'Git 挂载不能占用资料或原型目录')
  const sourcePath =
    input.sourcePath === undefined || input.sourcePath === '' ? undefined : path(input.sourcePath)
  return {
    id: id(sourceId),
    name: input.name.trim(),
    role: input.role,
    url: url.toString(),
    refKind: input.refKind,
    ref,
    mountPath,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(input.credentialId ? { credentialId: id(input.credentialId) } : {}),
  }
}
export function normalizeRepository(input: ProjectRepositoryDetails): ProjectRepositoryDetails {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['name', 'url', 'credentialId'].includes(key))
  )
    fail(400, 'REPOSITORY_INPUT_INVALID', '仓库连接只配置名称、地址和凭证')
  const value = normalizeSource(
    { ...input, role: 'other', refKind: 'default', ref: '', mountPath: 'repository' },
    'repository',
  )
  return {
    name: value.name,
    url: value.url,
    ...(value.credentialId ? { credentialId: value.credentialId } : {}),
  }
}
export function plainText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}
export function mimeFor(name: string, bytes: Uint8Array): string {
  const start = Buffer.from(bytes.subarray(0, 16))
  if (start.subarray(0, 5).toString() === '%PDF-') return 'application/pdf'
  if (start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (start[0] === 255 && start[1] === 216 && start[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(start.toString())) return 'image/gif'
  if (start.subarray(0, 4).toString() === 'RIFF' && start.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp'
  const extension = extname(name).toLowerCase()
  const office: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  if (office[extension] && start[0] === 80 && start[1] === 75) return office[extension]!
  if (plainText(bytes) !== null)
    return (
      (
        {
          '.md': 'text/markdown',
          '.txt': 'text/plain',
          '.json': 'application/json',
          '.html': 'text/html',
          '.svg': 'image/svg+xml',
          '.csv': 'text/csv',
          '.xml': 'application/xml',
        } as Record<string, string>
      )[extension] ?? 'text/plain'
    )
  return 'application/octet-stream'
}
export const editable = (name: string, mime: string) =>
  /\.(?:md|txt)$/i.test(name) && (mime === 'text/plain' || mime === 'text/markdown')
export const fileName = (value: string) => basename(value)
