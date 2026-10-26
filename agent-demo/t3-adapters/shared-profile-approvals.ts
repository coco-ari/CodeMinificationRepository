// @effect-diagnostics nodeBuiltinImport:off -- 运维验证文件只在可信来源准入边界同步读取，不读取凭据。
import { constants, closeSync, openSync, readFileSync, fstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import * as S from 'effect/Schema'
import { decodeContract } from '../../autoops/contracts/index.ts'
import {
  SharedProfileApproval, SharedProfileDescriptor,
  type SharedProfileCapability,
} from '../../autoops/contracts/shared-execution.ts'
import type { CustomerExecutionBinding } from '../../autoops/contracts/runtime.ts'

const Approvals = S.Array(SharedProfileApproval).check(S.isMaxLength(256))
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const denied = (): never => { throw Object.assign(new Error('此运行来源尚未取得实际隔离验证许可'), {
  status: 403, code: 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED',
}) }

/** 文件由部署运维在实际 OS 与原生模型验收后提供；客户自报或管理页面不能签发。 */
export function sharedProfileVerifier(path: () => string | undefined) {
  return (source: {
    providerId: string; sourceProjectId: string; target: CustomerExecutionBinding;
    profile: SharedProfileCapability | undefined;
  }): SharedProfileDescriptor => {
    if (!source.profile) return denied()
    const file = path()
    if (!file || !isAbsolute(file)) return denied()
    let approvals: ReadonlyArray<SharedProfileApproval>
    try {
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(descriptor)
        if (!stat.isFile() || stat.size > 512 * 1024 || (stat.mode & 0o022) !== 0) return denied()
        approvals = decodeContract(Approvals, JSON.parse(readFileSync(descriptor, 'utf8')))
      } finally { closeSync(descriptor) }
    } catch { return denied() }
    const profile = decodeContract(SharedProfileDescriptor, {
      id: source.profile.id, revision: source.profile.revision, digest: source.profile.digest,
      imageDigest: source.profile.imageDigest, policy: source.profile.policy,
    })
    if (!approvals.some(approval => approval.providerId === source.providerId &&
      approval.sourceProjectId === source.sourceProjectId &&
      stable(approval.target) === stable(source.target) && stable(approval.profile) === stable(profile) &&
      Number.isFinite(Date.parse(approval.verifiedAt)))) return denied()
    return profile
  }
}
export type SharedProfileVerifier = ReturnType<typeof sharedProfileVerifier>
