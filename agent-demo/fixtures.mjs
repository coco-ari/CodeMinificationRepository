export const users = [
  { id: 'u-admin', username: 'admin', name: '陶然', role: 'admin' },
  { id: 'u-lin', username: 'lin', name: '林晓', role: 'member' },
  { id: 'u-chen', username: 'chen', name: '陈一', role: 'member' },
  { id: 'u-guest', username: 'guest', name: '外部协作成员', role: 'member' },
]
export const projects = [
  {
    id: 'p-autoops',
    name: 'AutoOps 工作台',
    memberIds: ['u-admin', 'u-lin', 'u-guest'],
    memberships: [
      { userId: 'u-guest', workspaceAccess: 'external', role: 'member', environmentIds: ['env-test'], status: 'active' },
    ],
    environments: [
      { id: 'env-test', name: '测试环境' },
      { id: 'env-prod', name: '生产环境' },
    ],
    documents: [
      {
        id: 'doc-design',
        name: '工作台设计与边界.md',
        mime: 'text/markdown',
        excerpt: '项目、资料、内置 Agent 与只读工具',
        content:
          '# AutoOps 工作台设计\n\n平台聚合项目资料、环境资源、内置 Agent 和报告。首轮内置 Agent 只读取资料、固定源码和获授权的只读工具。Agent 不执行部署、不修改数据库、不变更机柜。\n\n## 会话\n每个会话固定项目、环境和 Agent。私有会话只对创建者可见，项目共享会话只对项目成员可见。一次会话同时执行一个轮次，跨会话最多五个任务。运行中补充可选择引导当前轮次或排队到下一轮。停止后保留部分结果并暂停队列。\n\n## 验收\n答案应指出资料来源。测试机上的演示资源是脱敏夹具，不能据此认定真实生产环境健康。',
      },
      {
        id: 'doc-runbook',
        name: '环境检查手册.md',
        mime: 'text/markdown',
        excerpt: '资源健康、容量与风险检查顺序',
        content:
          '# 环境检查手册\n\n先确认目标环境，再依次检查服务健康、CPU/内存/磁盘容量、备份时间与错误趋势。磁盘超过80%为关注，超过90%为高风险。备份超过24小时需检查。报告必须区分观察事实、风险判断与建议，保留采集时间。\n\n生产环境检查仅可调用只读资源接口。没有获授权写入工具时，不自动清理磁盘、不重启服务。',
      },
    ],
    resources: [
      { id: 'res-api', name: 'API 服务', type: 'service', environmentId: 'env-test' },
      { id: 'res-db', name: '数据库', type: 'database', environmentId: 'env-prod' },
    ],
  },
  {
    id: 'p-cabinet',
    name: '机柜资源平台',
    memberIds: ['u-admin', 'u-chen'],
    environments: [
      { id: 'env-test', name: '测试环境' },
      { id: 'env-prod', name: '生产环境' },
    ],
    documents: [
      {
        id: 'doc-cabinet',
        name: '机柜迁移检查清单.md',
        mime: 'text/markdown',
        excerpt: '迁移前后数据核对，Agent仅提出检查建议',
        content:
          '# 机柜迁移检查清单\n\n迁移前核对源机柜、目标机柜、设备清单、端口映射和可用容量。迁移后比对设备数量、网络连通与业务健康。\n\n此演示的 Agent 只读取清单和生成核对报告，不调用迁移写入接口。若缺少源和目标机柜信息，应先向用户澄清。',
      },
    ],
    resources: [
      { id: 'rack-a', name: 'A01 机柜', type: 'cabinet', environmentId: 'env-test' },
      { id: 'rack-b', name: 'B02 机柜', type: 'cabinet', environmentId: 'env-prod' },
    ],
  },
]
export const agents = [
  {
    id: 'a-project',
    name: '项目助手',
    description: '查阅项目资料与环境资源',
    projectIds: projects.map((p) => p.id),
    capabilities: ['read', 'report', 'steer'],
  },
  {
    id: 'a-report',
    name: '报告助手',
    description: '归纳证据并生成可下载报告',
    projectIds: projects.map((p) => p.id),
    capabilities: ['read', 'report', 'steer'],
  },
]
export function contextFor(c) {
  const p = projects.find((p) => p.id === c.projectId)
  return {
    project: { id: p.id, name: p.name },
    environment: p.environments.find((e) => e.id === c.environmentId),
    documents: p.documents,
    resources: p.resources.filter((r) => r.environmentId === c.environmentId),
    resourceSnapshot: {
      source: '演示夹具（非真实生产监控）',
      collectedAt: new Date().toISOString(),
      services: [
        {
          name: 'api',
          status: 'healthy',
          cpuPercent: 23,
          memoryPercent: 54,
          diskPercent: c.environmentId === 'env-prod' ? 86 : 42,
        },
        { name: 'database', status: 'healthy', cpuPercent: 18, memoryPercent: 61, diskPercent: 58 },
      ],
      lastBackupHours: 6,
    },
  }
}
