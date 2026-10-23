# AutoOps

自托管的项目工作台，统一资料与工作区、技能、问答、客户本机能力、资源连接和发布部署。

当前按全新产品进行模块化重建：保留已确认业务流程和当前公共框架，优先复用锁定 T3 与成熟开源实现；不迁移旧数据或保留旧接口兼容。规范是目标，实现状态与验证结果单独记录。

## 从这里开始

- 开发与 AI 任务入口：[AGENTS.md](AGENTS.md)
- 规范导航：[规范索引](docs/README.md)
- 当前代码、启动与检查：[开发与验证](docs/development.md)
- 交付顺序：[AutoOps 全新模块化重建计划](examples/autoops-rebuild-plan.md)
- 产品要求：[当前业务需求](examples/workbench-v2-requirements.md)与[工作台设计](examples/project-workbench-design.md)

## 架构约束

单中心模块化单体，Node.js、严格 TypeScript、SQLite。业务模块拥有各自数据、公开服务与授权动作；HTTP、RPC、MCP 和后台调用复用同一用例。T3 拥有会话、轮次、队列和执行恢复，AutoOps 负责业务绑定与权限。

前端继续使用当前问答公共外壳，内容分别复用 T3 文件工作台、设置分组和目录卡片。平台问答、客户本机与部署任务分别遵循各自执行边界。

## 既有实现与历史

`agent-demo` 与 `vendor/t3code` 是当前已集成工作台；`src`、`agent` 和 `web` 中保留旧部署平台及原型供验证和能力复用。它们不构成新产品兼容约束，新模块不得从旧存储或适配器读取业务状态。

旧安装、使用和部署说明保存在[历史平台说明](docs/history/legacy-platform-readme.md)。其中的账号、页面、数据兼容和主题要求仅属于历史版本，不指导新产品开发。真实环境的运行状态以对应部署记录为准，不能从旧 README 推断当前新功能已上线。
