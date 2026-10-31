# AutoOps 规范索引

维护规则的目的，是让开发者和 AI 能快速找到权威约束，并用代码检查兑现。不要把同一规则复制到多个文件，也不要把所有规范一次塞入每个任务的上下文。

## 当前定稿状态

开发规范基线 v1 已建立，按实际需求持续维护；当前分支是唯一运行基线。实施阶段见[当前状态](development.md#当前状态)，本轮已确认范围、四类验证状态与未完成项见[完整交付实施清单](development.md#完整交付实施清单)。历史阶段和规范修订不重新启动已经完成的步骤，也不替代现有任务的继续交付。

阅读运行材料时，先定位上述当前入口，再按任务查阅模块与证据；历史章节中的“当前”“本轮”、旧端口及恢复命令只描述当时现场，不能直接用于现行环境。执行前按当前发行记录核对真实目标；发现冲突只核对相关来源，不重复全量扫描历史。

## 权威来源

| 来源 | 负责回答 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 每次任务如何开始、不可破坏的边界、完成条件 |
| [工程与 AI 协作规范](../examples/engineering-standard.md) | 如何组织变更、前端状态、公共合同、测试、依赖与交接 |
| [后端规范](../examples/backend-standard.md) | 数据归属、分层、授权、事务、任务、配置及运维 |
| [T3 UI 规范](../examples/t3-ui-standard.md) | 外壳、呈现、原生组件、密度、交互和可视验收 |
| [原生组件统一与旧前端退出](validation/frontend-native-ui.md) | 全站 Base UI 迁移、旧入口清理、焦点及浏览位置恢复、必要回归与 workbench 虚拟机发布证据 |
| [平台问答直接配置](validation/direct-question.md) | 有调整权限者无需助手即可问答、可选预设、受限与电脑来源授权及对应验证 |
| [工作台导航与配置体验](../examples/workbench-navigation-design.md) | 五个活跃开源项目调研、全局工作台与项目导航分层、助手整页编辑；[本批验证](validation/workbench-navigation.md) |
| [创建与删除闭环](../examples/resource-deletion-design.md) | 删除入口、级联归属、共享资源与失败恢复；[本批验证](validation/resource-deletion.md) |
| [当前业务需求](../examples/workbench-v2-requirements.md) | 产品要实现什么、谁可以操作什么 |
| [工作台设计](../examples/project-workbench-design.md) | [创建项目与功能启用总图](../examples/project-workbench-design.md#项目建立与功能启用总图)、[已确认权限设计](../examples/project-workbench-design.md#项目权限设计)、[统一助手与用户运行来源](../examples/project-workbench-design.md#统一助手与用户提供的运行来源)、[方案一致性审查](../examples/project-workbench-design.md#方案一致性审查2026-10-26)，以及工作区、交付物、会话与扩展的业务关系；新增设计与实现状态分开 |
| [部署核心适配方案（已确认）](../examples/deployment-core-adaptation-plan.md) | 固定 main 提交的完整部署能力、当前接入缺口、数据归属与分批实施范围；旧 Jenkins／脚本源码下载明确退役 |
| [中心源码 ZIP 与包内配置](validation/zip-source-deployment.md) | 业务环境配置随源码 ZIP 固定、中心回滚待上线与企业版实际迁移记录；凭据适用范围统一见 [AGENTS.md](../AGENTS.md#交付纪律) |
| [Java 部署可选环境文件](validation/deployment-env-file.md) | env_file 的旧项目兼容、节点能力、文件校验、重启／恢复语义、1.6.2 上线验证与用户安装步骤 |
| [部署工作台本批验证](validation/deployment-workbench.md) | 环境服务导航、连续配置、固定提交、权限与原请求恢复的本地实现和未上线边界 |
| [重建计划](../examples/autoops-rebuild-plan.md) | 最新三步顺序、保留的完整业务要求及早期阶段 0–7 参考 |
| [开发与验证](development.md) | 当前可执行的启动、检查、测试命令与实现状态 |
| [当前运行模块与检查入口](runtime-modules.md) | 实际工作台各模块的数据所有者、公开边界、依赖门禁与完整回归命令 |
| [AutoOps 模块入口](../autoops/README.md) | 新代码职责、数据所有权、公开入口及采用的开源能力 |

规则与实现现状分开：专项规范是目标；开发文档及测试记录是当前证据。当前分支已有功能必须保留并优化；旧实现不强制成为内部兼容要求，历史原型与评估也不代表当前事实。[历史平台说明](history/legacy-platform-readme.md)不指导新产品的 UI、权限、数据或接口设计。

并行批次的独立证据：[新账号与项目开始使用引导](validation/project-onboarding.md)。该记录包含分支基线、操作对比和验证边界；是否已合并及上线以主任务交付清单和对应发行证据为准。

## 维护方法

- 业务规则变化：更新业务需求及相应专项规范，合同和测试同步修改；不在根入口追加长篇实现记录。
- 影响多个模块的决定：在相关规范写明背景、选择、替代方案不适用的原因及边界。局部代码技巧写在必要的中文注释里。
- API 字段、表结构和命令参数以代码合同、升级文件与可执行帮助为准，不手写第二套字段大全。
- 完整计划保留业务目标与流程，实施范围服从用户最新确认及开发文档中的现有清单；早期阶段号只用于追溯，不能扩大 main 专项适配范围或漏掉已接受事项。状态记录与历史归档按[工程规范](../examples/engineering-standard.md#规范与决策维护)维护，批次摘要不能取代业务要求。临时日志、截图、调研下载保存在忽略目录或仓库外。
