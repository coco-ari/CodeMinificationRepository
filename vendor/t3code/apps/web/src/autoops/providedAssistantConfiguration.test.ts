import { expect, it } from 'vite-plus/test'
import type { ProvidedAssistantSource } from '../../../../../../autoops/contracts/assistants.ts'
import {
  providedConfigurationIssue,
  providedProfileDescriptor,
  providedRuntimeCatalog,
  providedRuntimeKey,
} from './providedAssistantConfiguration'

const profile = {
  id: 'verified-profile',
  revision: 3,
  digest: 'a'.repeat(64),
  imageDigest: `sha256:${'b'.repeat(64)}`,
  policy: 'linux-docker-readonly-v1' as const,
}
function source(): ProvidedAssistantSource {
  const binding = {
    kind: 'customer' as const,
    deviceId: 'device-one',
    registeredWorkspaceId: 'root-one',
    workspaceBindingRevision: 2,
    runtimeId: 'codex' as const,
  }
  return {
    executionBinding: binding,
    sourceProjectId: 'source-project',
    deviceName: '本人电脑',
    workspaceName: '登记目录',
    deviceStatus: 'active',
    workspaceStatus: 'active',
    online: true,
    sharedProfileAvailable: true,
    capabilities: {
      ...binding,
      protocolVersion: 1,
      revision: 'catalog',
      updatedAt: 'now',
      assistantConfiguration: true,
      models: [
        { id: 'self-model', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' },
      ],
      skills: [{ id: 'self-skill', name: '本机skill', description: '' }],
      sharedProfile: {
        ...profile,
        models: [
          {
            id: 'isolated-model',
            supportedReasoningEfforts: ['high'],
            defaultReasoningEffort: 'high',
          },
        ],
        skills: [{ id: 'isolated-skill', name: '隔离skill', description: '' }],
      },
    },
  }
}
const draft = () => ({
  runtime: profile,
  model: 'isolated-model',
  reasoning: 'high',
  skillIds: ['isolated-skill'],
})

it('新预设先显式选运行目录，模型及skill不从首项或平台补齐', () => {
  const s = source()
  expect(providedRuntimeCatalog(s, null)).toMatchObject({
    available: false,
    models: [],
    skills: [],
  })
  expect(providedRuntimeCatalog(s, 'self').models.map((x) => x.id)).toEqual(['self-model'])
  expect(providedRuntimeCatalog(s, profile).models.map((x) => x.id)).toEqual(['isolated-model'])
  expect(providedRuntimeCatalog(s, profile).skills.map((x) => x.id)).toEqual(['isolated-skill'])
  expect(providedConfigurationIssue(s, { ...draft(), model: '' })).toContain('请选择')
  expect(providedConfigurationIssue(s, draft())).toBeNull()
  expect(providedConfigurationIssue(s, { ...draft(), model: 'self-model' })).toContain(
    '所选运行目录',
  )
  expect(providedConfigurationIssue(s, { ...draft(), skillIds: ['self-skill'] })).toContain(
    '所选skill',
  )
})

it.each(['unverified', 'withdrawn', 'changed', 'missing', 'offline'] as const)(
  '隔离目录%s仍保留原选择并明确阻止保存，不回退自用目录',
  (kind) => {
    const s = source(),
      original = draft()
    if (kind === 'unverified') {
      s.sharedProfileAvailable = false
      s.sharedProfileReason = { code: 'REVOKED', message: '隔离许可已撤回' }
    }
    if (kind === 'withdrawn') s.workspaceStatus = 'revoked'
    if (kind === 'changed')
      s.capabilities!.sharedProfile = { ...s.capabilities!.sharedProfile!, revision: 4 }
    if (kind === 'missing') delete s.capabilities!.sharedProfile
    if (kind === 'offline') s.online = false
    const catalog = providedRuntimeCatalog(s, original.runtime)
    expect(catalog.available).toBe(false)
    expect(catalog.reason).toBeTruthy()
    expect(catalog.models.some((x) => x.id === 'self-model')).toBe(false)
    expect(providedConfigurationIssue(s, original)).not.toBeNull()
    expect(original).toEqual(draft())
  },
)

it('能力变化保留原参数，阻止消失的模型、强度、skill及重复skill', () => {
  const s = source(),
    original = draft()
  expect(providedConfigurationIssue(s, { ...original, reasoning: 'low' })).toContain('实际支持')
  expect(providedConfigurationIssue(s, { ...original, reasoning: null })).toContain('实际支持')
  expect(
    providedConfigurationIssue(s, { ...original, skillIds: ['isolated-skill', 'isolated-skill'] }),
  ).toContain('所选skill')
  s.capabilities!.sharedProfile = { ...s.capabilities!.sharedProfile!, models: [] }
  expect(providedConfigurationIssue(s, original)).toContain('所选运行目录')
  expect(original).toEqual(draft())
})

it('不支持思考档位的真实模型仅接受null，不注入平台默认强度', () => {
  const s = source()
  s.capabilities!.models = [{ id: 'no-effort', supportedReasoningEfforts: [] }]
  expect(
    providedConfigurationIssue(s, {
      runtime: 'self',
      model: 'no-effort',
      reasoning: null,
      skillIds: [],
    }),
  ).toBeNull()
  expect(
    providedConfigurationIssue(s, {
      runtime: 'self',
      model: 'no-effort',
      reasoning: 'high',
      skillIds: [],
    }),
  ).toContain('实际支持')
})

it('隔离目录身份精确包括镜像及版本，提交描述不携带能力目录或额外字段', () => {
  const projected = { ...profile, models: [{ id: 'hidden' }], secret: 'never-submit' }
  expect(providedProfileDescriptor(projected)).toEqual(profile)
  expect(providedRuntimeKey(projected)).toBe(JSON.stringify(profile))
  expect(providedRuntimeKey({ ...profile, imageDigest: `sha256:${'c'.repeat(64)}` })).not.toBe(
    providedRuntimeKey(profile),
  )
  expect(providedRuntimeKey('self')).toBe('self')
  expect(providedRuntimeKey(null)).toBe('')
})
