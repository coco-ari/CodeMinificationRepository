# AutoOps

自托管的项目工作台，统一资料与工作区、技能、问答、客户本机能力、资源连接和发布部署。

当前按“完善规范 → 深度优化全部现有模块 → 开发新增功能”推进。当前分支是唯一功能基线，保留现有业务流程与公共框架，优先复用锁定 T3 与成熟开源实现。规范基线已整理，实现符合性在后续优化中逐项验证；当前状态与检查证据单独记录。

## 从这里开始

- 开发与 AI 任务入口：[AGENTS.md](AGENTS.md)
- 规范导航：[规范索引](docs/README.md)
- 当前代码、启动与检查：[开发与验证](docs/development.md)
- 新产品模块职责与公开入口：[AutoOps 模块入口](autoops/README.md)
- 交付顺序：[AutoOps 全新模块化重建计划](examples/autoops-rebuild-plan.md)
- 产品要求：[当前业务需求](examples/workbench-v2-requirements.md)与[工作台设计](examples/project-workbench-design.md)

## 架构约束

单中心模块化单体，Node.js、严格 TypeScript、SQLite。业务模块拥有各自数据、公开服务与授权动作；HTTP、RPC、MCP 和后台调用复用同一用例。T3 拥有会话、轮次、队列和执行恢复，AutoOps 负责业务绑定与权限。

前端继续使用当前问答公共外壳，内容分别复用 T3 文件工作台、设置分组和目录卡片。平台问答、客户本机与部署任务分别遵循各自执行边界。

## 既有实现与历史

`agent-demo` 与 `vendor/t3code` 是当前已集成工作台；`src`、`agent` 和 `web` 中保留部署平台及原型代码。第二步按真实入口、调用与数据归属逐批优化，不能因目录名删除当前能力。替换后的模块通过公开合同协作，不依赖旧内部存储或保留长期双写；新平台初始化及使用中数据的保护规则见 AGENTS.md。

旧安装、使用和部署说明保存在[历史平台说明](docs/history/legacy-platform-readme.md)。其中的账号、页面、数据兼容和主题要求仅属于历史版本，不指导新产品开发。真实环境的运行状态以对应部署记录为准，不能从旧 README 推断当前新功能已上线。
