export const BUILTIN_BUSINESS_SKILLS = Object.freeze([
  {
    name: 'project-brief',
    displayName: '项目资料解读',
    enabled: true,
    builtin: true,
    description: '阅读当前项目的授权资料，整理目标、设计、已确认事项与待补充信息，并附真实来源。',
    tools: [
      'list_project_materials',
      'read_project_document',
      'read_project_material',
      'read_attachment',
      'ask_user',
    ],
    instructions: `# 项目资料解读
先用 list_project_materials 了解当前项目的资料目录，按问题读取相关资料或用户指定的附件。不要只凭文件名回答。
按“项目目标、设计与约束、已确认事项、待补充信息”组织中文回复；与问题无关的栏目可以省略。
区分资料中的事实、你的推断和缺失的信息；冲突资料注明各自来源。使用实际读取结果中的 sourceUrl 引用来源，不编造链接。
资料不足时说明缺口，必要时使用 ask_user 提出清晰问题。不要读取其他项目或宿主文件。`,
  },
  {
    name: 'environment-check',
    displayName: '环境健康检查',
    enabled: true,
    builtin: true,
    description: '结合环境真实只读查询和项目检查手册，给出观察事实、风险与建议，明确来源和时效。',
    tools: [
      'list_project_materials',
      'read_project_document',
      'read_project_material',
      'query_environment',
      'read_environment',
      'ask_user',
    ],
    instructions: `# 环境健康检查
先读取相关环境检查手册，再调用 query_environment 列出本轮环境连接，用 read_environment 按目录允许操作读取真实数据。
明确数据来源、采集时间和局限。未配置、停用、失效或连接失败时说明缺口，不用演示快照、记忆或其他环境代替。
按“观察事实、风险判断、建议”给出中文结果，阈值只能来自实际资料。缺少日志、错误趋势等指标时说明缺口，不编造正常结论。
这是只读检查，不执行删除文件、清盘、重启、部署或改库。用户要求不同环境时提醒新建对话选择该环境。`,
  },
  {
    name: 'release-readiness',
    displayName: '发布准备报告',
    enabled: true,
    builtin: true,
    description: '核对设计、检查手册及环境证据，整理发布准备情况，生成可预览和下载的会话报告。',
    tools: [
      'list_project_materials',
      'read_project_document',
      'read_project_material',
      'read_attachment',
      'query_environment',
      'read_environment',
      'ask_user',
      'create_report',
    ],
    instructions: `# 发布准备报告
按需读取当前项目的设计、发布检查手册和用户提供的附件，再通过 query_environment 发现连接并用 read_environment 查询本轮固定环境。
报告至少包含：检查范围、资料来源、环境证据、已满足事项、缺失与阻塞、风险、下一步建议。缺少版本、测试、回滚方案等证据时如实标为未确认。
区分报告生成时间与数据采集时间；无可用连接或实际查询失败时明确标为缺失，不能用历史或演示数据代替。结论不得虚构发布已执行或生产放行。
调用 create_report 保存中文 Markdown 或 PDF 报告，并以工具实际返回的授权预览/下载链接交付。正文给出简洁摘要；不能只说已生成而没有真实文件。
不执行部署、服务器变更、数据库写入或机柜迁移。`,
  },
])
