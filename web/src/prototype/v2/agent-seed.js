export function seedAgents() {
  return {
    agents: [
      {
        id: 'agent-platform-sol',
        name: '项目分析助手',
        description: '结合项目文档、脱敏源码与环境状态，回答问题并生成分析报告。',
        kind: 'platform',
        ownerId: 'admin',
        sharing: 'project',
        projectId: 'sol',
        status: 'online',
        instructions:
          '依据项目资料回答问题，清晰引用来源。外部资源仅执行只读查询；不执行部署、数据库写入或机柜变更。',
        runtime: '内置只读运行时',
        model: '演示推理模型',
        supportsImages: true,
        supportsDocuments: true,
      },
      {
        id: 'agent-platform-atlas',
        name: 'Atlas 文档助手',
        description: '检索 Atlas 项目资料并生成可引用的分析结果。',
        kind: 'platform',
        ownerId: 'admin',
        sharing: 'project',
        projectId: 'atlas',
        status: 'online',
        instructions: '仅根据授权资料进行只读分析，输出文档来源和不确定项。',
        runtime: '内置只读运行时',
        model: '演示推理模型',
        supportsImages: true,
        supportsDocuments: true,
      },
    ],
    conversations: [
      {
        id: 'conversation-sol-intro',
        projectId: 'sol',
        agentId: 'agent-platform-sol',
        creatorId: 'admin',
        environmentId: 'sol-test',
        title: '测试环境发布准备情况',
        createdAt: '2026-10-20T01:10:00.000Z',
        sourceMode: 'sanitized',
        sourceArtifactId: 'sanitized-sol',
        scopeIds: [],
        queue: [],
        messages: [
          {
            id: 'msg-intro-1',
            role: 'user',
            content: '帮我梳理测试环境发布前需要检查的事项。',
            at: '2026-10-20T01:10:00.000Z',
            actorId: 'admin',
          },
          {
            id: 'msg-intro-2',
            role: 'assistant',
            at: '2026-10-20T01:10:12.000Z',
            content:
              '建议先确认所选版本的源码与构建产物，再检查服务器连接、服务健康检查和上一个可回退版本。\n\n环境资源的检查结果仅供分析。实际部署需要在服务页面手动选择版本并确认。\n\n当前是交互原型，展示的连接状态和分析结果均为模拟数据。',
            citations: [
              {
                id: 'doc-release-sol',
                label: '发布检查.txt',
                kind: 'document',
                excerpt: '确认目标环境、来源提交和可回退版本。',
              },
            ],
            steps: [
              {
                name: 'project.materials.search',
                args: { query: '发布准备', projectId: 'sol' },
                result: '命中 1 份项目文档',
                status: 'success',
              },
              {
                name: 'resource.status.read',
                args: { environmentId: 'sol-test', readOnly: true },
                result: '测试环境资源状态读取完成（模拟）',
                status: 'success',
              },
            ],
          },
        ],
      },
    ],
  }
}
