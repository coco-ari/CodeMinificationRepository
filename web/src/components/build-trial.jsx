import { useState } from 'react'
import { Field, FormDialog, Notice } from './shared'
import { Button } from '@/components/ui/button'
import { useConsole } from '@/lib/console'

export const frontendPresets = [
  {
    name: '现代项目 · Node 22 / npm 10',
    buildImage: 'node:22-bookworm-slim',
    packageManager: 'npm',
    packageManagerVersion: '10.9.9',
  },
  {
    name: '旧项目 · Node 14 / npm 8',
    buildImage: 'node:14.21.3-bullseye',
    packageManager: 'npm',
    packageManagerVersion: '8.19.4',
  },
  {
    name: 'pnpm 项目 · Node 22 / pnpm 10',
    buildImage: 'node:22-bookworm-slim',
    packageManager: 'pnpm',
    packageManagerVersion: '10.11.0',
  },
  {
    name: 'Yarn Classic · Node 22',
    buildImage: 'node:22-bookworm-slim',
    packageManager: 'yarn',
    packageManagerVersion: '1.22.22',
  },
]

export function BuildTrial({ target, config, selection, subject, onClose }) {
  const { request, endpoint, navigate, confirm } = useConsole()
  const [draft, setDraft] = useState({
    ...config,
    installMode: config.installMode || 'frozen',
    legacyPeerDeps: !!config.legacyPeerDeps,
  })
  const [requestState] = useState({ fingerprint: '', requestId: '' })
  const update = (name, value) => setDraft((old) => ({ ...old, [name]: value }))
  return (
    <FormDialog
      wide
      title="前端试构建"
      description="仅验证所选源码的依赖安装、打包和产物。这里的修改只用于本次试构建，不保存部署配置、不切换站点、不新增发布版本。"
      onClose={onClose}
      submitLabel="确认试构建"
      onSubmit={async () => {
        const buildConfig = Object.fromEntries(
          [
            'module',
            'buildImage',
            'packageManager',
            'packageManagerVersion',
            'installMode',
            'legacyPeerDeps',
            'buildScript',
            'buildArgs',
            'artifactPath',
            'build',
          ].map((key) => [key, draft[key]]),
        )
        const payload = { targetId: target.id, action: 'build-check', ...selection, buildConfig }
        buildConfig.buildArgs = (draft.buildArgs || []).map((arg) => arg.trim()).filter(Boolean)
        const fingerprint = JSON.stringify(payload)
        if (requestState.fingerprint !== fingerprint)
          Object.assign(requestState, { fingerprint, requestId: crypto.randomUUID() })
        confirm(
          '确认试构建',
          '使用以下工具链执行构建，验证成功后临时产物会清理，线上站点保持不变。',
          async () => {
            const result = await request(`${endpoint}/tasks`, {
              ...payload,
              requestId: requestState.requestId,
            })
            onClose()
            navigate('tasks', result.task.id, target.environmentId)
          },
          {
            details: [
              ['分支', selection.branch],
              ['提交说明', subject],
              ['Commit', selection.revision],
              ['项目目录', draft.module || '.'],
              ['构建镜像', draft.buildImage],
              ['包管理器', `${draft.packageManager}@${draft.packageManagerVersion}`],
              ['构建脚本', `${draft.buildScript} ${(draft.buildArgs || []).join(' ')}`],
              ['安装方式', draft.installMode === 'install' ? '兼容安装' : '锁定安装'],
              ['产物目录', draft.artifactPath],
            ],
          },
        )
      }}
    >
      <div className="flex flex-wrap gap-2">
        {frontendPresets.map(({ name, ...preset }) => (
          <Button
            key={name}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDraft((old) => ({ ...old, ...preset, legacyPeerDeps: false }))}
          >
            {name}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="前端项目目录"
          value={draft.module || '.'}
          required
          onChange={(e) => update('module', e.target.value)}
          hint="相对仓库根目录；更换目录后请同时核对产物目录。"
        />
        <Field
          label="构建镜像"
          value={draft.buildImage}
          required
          onChange={(e) => update('buildImage', e.target.value)}
          hint="可填写包含对应 Node、Python 和编译工具的自定义镜像；不修改服务器环境。"
        />
        <Field
          label="包管理器"
          value={draft.packageManager}
          choices={['npm', 'pnpm', 'yarn'].map((name) => [
            name,
            name === 'yarn' ? 'Yarn Classic' : name,
          ])}
          onChange={(e) => {
            update('packageManager', e.target.value)
            update('legacyPeerDeps', false)
          }}
        />
        <Field
          label="包管理器准确版本"
          value={draft.packageManagerVersion}
          required
          onChange={(e) => update('packageManagerVersion', e.target.value)}
        />
        <Field
          label="依赖安装方式"
          value={draft.installMode}
          choices={[
            ['frozen', '锁定安装（推荐）'],
            ['install', '兼容安装（允许生成锁文件）'],
          ]}
          onChange={(e) => update('installMode', e.target.value)}
        />
        <Field
          label="npm peer 依赖处理"
          value={draft.legacyPeerDeps ? 'legacy' : 'strict'}
          disabled={draft.packageManager !== 'npm'}
          choices={[
            ['strict', '使用仓库默认规则'],
            ['legacy', '忽略旧项目 peer 冲突'],
          ]}
          onChange={(e) => update('legacyPeerDeps', e.target.value === 'legacy')}
        />
        <Field
          label="构建脚本"
          value={draft.buildScript}
          required
          onChange={(e) => update('buildScript', e.target.value)}
        />
        <Field
          label="产物目录"
          value={draft.artifactPath}
          required
          onChange={(e) => update('artifactPath', e.target.value)}
          hint="相对仓库根目录，必须包含 index.html。"
        />
        <Field
          label="构建参数（每行一个）"
          multiline
          value={(draft.buildArgs || []).join('\n')}
          onChange={(e) => update('buildArgs', e.target.value.split('\n'))}
          hint="例如两行分别填写 --mode 和 test；不要合在一行。"
        />
        <Field
          label="构建内存（MB）"
          type="number"
          min="256"
          max="65536"
          value={draft.build?.memoryMb || 1024}
          onChange={(e) => update('build', { ...draft.build, memoryMb: Number(e.target.value) })}
        />
      </div>
      <Notice>
        {draft.installMode === 'install'
          ? '兼容安装可能解析出新的依赖版本，不能保证以后重建一致；生成的锁文件只存在本次工作目录，不会写回仓库。'
          : '锁定安装需要提交所选包管理器的锁文件。'}{' '}
        旧工具链仅用于适配旧项目；项目本身的依赖冲突仍需在源码中修正。
      </Notice>
    </FormDialog>
  )
}
