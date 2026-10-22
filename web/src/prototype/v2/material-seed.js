export const DEMO_COMMIT = '38e20cfb3d649a72ab4c87d83109ab769420a59f'

export function demoSourceFiles(projectId = 'sol') {
  const name = projectId === 'sol' ? 'SOL 设备平台' : 'Atlas 研发平台'
  return [
    {
      name: 'README.md',
      content: `# ${name}\n\n内部开发与运维资料。\n\n## 本地运行\n\n使用独立测试环境连接，执行构建后检查健康接口。\n\n所有示例配置均为虚构演示数据。`,
    },
    {
      name: 'docs/architecture.md',
      content: `# ${name}系统边界\n\n服务负责设备接入、鉴权和业务查询。\n\n- 测试与生产环境分别配置资源。\n- 发布失败自动恢复上一个运行版本。\n- 机柜鉴权成功不能作为 MQTT 在线依据。\n`,
    },
    {
      name: 'docs/runbook/deployment.md',
      content:
        '# 发布检查\n\n1. 选择固定提交对应的源码产物。\n2. 确认目标环境与服务器。\n3. 构建、启动并检查健康状态。\n4. 查看发布日志与版本记录。\n',
    },
    {
      name: 'src/server.js',
      content:
        "export function health() {\n  return { status: 'ok', service: 'workbench-demo' }\n}\n",
    },
    {
      name: 'application.yml',
      content:
        'database:\n  host: mysql.example.invalid\n  username: demo_app\n  password: "fictional-db-password-2026"\nredis:\n  password: "fictional-cache-password"\n',
    },
    {
      name: '.env.example',
      content:
        'API_TOKEN=fictional-token-never-valid\nACCESS_KEY=fictional-access-key\nINTERNAL_DOMAIN=internal.example.invalid\n',
    },
    {
      name: '.git/config',
      content: '[remote "origin"]\n  url = https://git.example.invalid/team/demo.git\n',
    },
    { name: '.git/HEAD', content: 'ref: refs/heads/main\n' },
    { name: '.git/logs/HEAD', content: `${DEMO_COMMIT} demo initial commit\n` },
    { name: '.gitignore', content: 'node_modules/\ndist/\n.env\n' },
    { name: '.gitattributes', content: '* text=auto\n' },
    {
      name: '.github/workflows/ci.yml',
      content:
        'name: CI\non: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "demo build"\n',
    },
  ]
}

export function seedMaterials(projectId) {
  const createdAt = '2026-10-20T02:15:00.000Z'
  const raw = demoSourceFiles(projectId)
  const sanitized = raw.map((file) => ({
    ...file,
    content: file.content
      .replaceAll('fictional-db-password-2026', '[REDACTED]')
      .replaceAll('fictional-cache-password', '[REDACTED]')
      .replaceAll('fictional-token-never-valid', '[REDACTED]')
      .replaceAll('fictional-access-key', '[REDACTED]')
      .replaceAll('internal.example.invalid', 'example.invalid'),
  }))
  return {
    documents: [
      {
        id: `folder-product-${projectId}`,
        parentId: null,
        kind: 'folder',
        name: '产品与需求',
        source: 'local',
        updatedAt: createdAt,
      },
      {
        id: `folder-ops-${projectId}`,
        parentId: null,
        kind: 'folder',
        name: '运维手册',
        source: 'local',
        updatedAt: createdAt,
      },
      {
        id: `folder-release-${projectId}`,
        parentId: `folder-ops-${projectId}`,
        kind: 'folder',
        name: '发布与回退',
        source: 'local',
        updatedAt: createdAt,
      },
      {
        id: `doc-spec-${projectId}`,
        parentId: `folder-product-${projectId}`,
        kind: 'file',
        name: '系统需求.md',
        mime: 'text/markdown',
        source: 'local',
        content:
          '# 系统需求\n\n## 目标\n统一组织一个业务系统的环境、资料、资源与人工操作。\n\n## 验收\n- 测试和生产环境独立配置。\n- 所有操作能查看结果与日志。\n- 机柜进入全局池，由人工分配鉴权目标。\n',
        updatedAt: createdAt,
      },
      {
        id: `doc-release-${projectId}`,
        parentId: `folder-release-${projectId}`,
        kind: 'file',
        name: '发布检查.txt',
        mime: 'text/plain',
        source: 'local',
        content:
          '发布前：确认版本、环境和服务器。\n发布后：检查健康状态和日志。\n失败时：恢复上一个运行版本。\n',
        updatedAt: createdAt,
      },
      {
        id: `doc-readme-${projectId}`,
        parentId: null,
        kind: 'file',
        name: 'README.md',
        mime: 'text/markdown',
        source: 'git',
        repositoryId: `repo-api-${projectId}`,
        gitPath: 'README.md',
        gitRef: 'main',
        content: raw[0].content,
        commit: DEMO_COMMIT,
        syncedAt: createdAt,
        updatedAt: createdAt,
      },
    ],
    repositories: [
      {
        id: `repo-api-${projectId}`,
        name: `${projectId}-api`,
        provider: 'GitHub',
        url: `https://github.com/example/${projectId}-api.git`,
        private: true,
        username: 'demo-bot',
        token: 'fictional-token',
        defaultBranch: 'main',
      },
      {
        id: `repo-web-${projectId}`,
        name: `${projectId}-web`,
        provider: 'Gitee',
        url: `https://gitee.com/example/${projectId}-web.git`,
        private: false,
        username: '',
        token: '',
        defaultBranch: 'main',
      },
    ],
    artifacts: [
      {
        id: `sanitized-${projectId}`,
        name: `${projectId}-api · 脱敏源码`,
        type: 'sanitized',
        status: 'ready',
        files: sanitized,
        sourceId: `source-${projectId}`,
        repositoryId: `repo-api-${projectId}`,
        repositoryName: `${projectId}-api`,
        refType: 'branch',
        ref: 'main',
        commit: DEMO_COMMIT,
        createdAt,
      },
      {
        id: `source-${projectId}`,
        name: `${projectId}-api · main`,
        type: 'source',
        status: 'ready',
        files: raw,
        repositoryId: `repo-api-${projectId}`,
        repositoryName: `${projectId}-api`,
        refType: 'branch',
        ref: 'main',
        commit: DEMO_COMMIT,
        createdAt,
      },
    ],
    rules: [
      {
        id: `rule-domain-${projectId}`,
        find: 'internal.example.invalid',
        replace: 'example.invalid',
      },
    ],
  }
}
