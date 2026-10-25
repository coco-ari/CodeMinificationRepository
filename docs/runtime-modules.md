# 当前运行模块与检查入口

这里记录当前分支的实现及调用边界，不替代[开发规范](README.md)。线上工作台仍由 `agent-demo` 网关、锁定 T3 和业务适配器组成；独立 `autoops/server` 的账号与项目后端另用 `verify:autoops` 验证，尚未替代线上身份或数据。历史目录中仍被调用的能力继续保留。

## 启动与装配

- `pnpm start:agent-demo` 启动[网关](../agent-demo/server.mjs)，T3 模式由 `AGENT_DEMO_ENGINE=t3` 选择；网关负责登录、同源 HTTP/WebSocket 代理与静态资源，不拥有 T3 轮次。
- `pnpm start:agent-demo:t3` 通过[启动器](../scripts/start-t3-worker.mjs)装配锁定 T3 worker，监听回环地址。`DATA_DIR`、`AUTOOPS_T3_BASE_DIR`、`AUTOOPS_T3_PORT` 及外置凭据沿当前部署配置提供；不得用测试默认值覆盖已有服务。
- T3 [HTTP 适配入口](../vendor/t3code/apps/server/src/autoops/http.ts)、[RPC 适配入口](../vendor/t3code/apps/server/src/autoops/rpc.ts)及客户接入入口，从认证请求取得身份后调用业务适配器。T3 原生会话、命令、事件及恢复仍由上游服务拥有。
- 前端由 [hostConfig](../vendor/t3code/apps/web/src/autoops/hostConfig.ts) 组合启动与公开出口；[hostSnapshot](../vendor/t3code/apps/web/src/autoops/hostSnapshot.ts) 只保存已认证宿主快照和用户存储视图，[threadScopes](../vendor/t3code/apps/web/src/autoops/threadScopes.ts) 通过统一客户端处理会话范围。页面继续使用当前 T3 路由与公共框架，组件不读取服务端表或凭证。
- 部署保留 [DeploymentService](../src/deployment.mjs) 与 [Agent](../agent/main.mjs) 的现有协议、构建及恢复；业务适配器只提供项目授权、独立 Git 源码包与公开 DTO。

## 已实现模块

表中的验证路径均为当前测试入口；列出测试不表示本次已执行或全部通过。持久文件属于配置的数据目录，不能在发布时用示例或旧备份覆盖。

| 模块与公开入口                                                                                                                                                                                                                                   | 数据、状态及权限所有者                                                                                                                            | 允许依赖与调用边界                                                                                                                                                                                                   | 主要验证                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 登录与网关：[server.mjs](../agent-demo/server.mjs)、[gateway.mjs](../agent-demo/t3-adapters/gateway.mjs)                                                                                                                                         | 网关登录会话及 CSRF；T3 登录映射由 access 管理；目前业务账号目录仍有既有示例来源，不等同于新账号后端接入                                          | 调用 access 与 T3 同源代理；不直接发起第二套对话执行                                                                                                                                                                 | `t3-host-csp.test.mjs`、`access.test.mjs`、`t3-worker-policy.test.mjs`                                                         |
| 项目、环境及会话授权：[access.mjs](../agent-demo/t3-adapters/access.mjs)、[rpc-policy.mjs](../agent-demo/t3-adapters/rpc-policy.mjs)                                                                                                             | `t3-autoops.sqlite` 中的业务绑定、附件授权和原生会话映射；固定项目、环境、资料范围、私有受众及执行目标；每轮输入和显式历史引用的授权关系归 access | 引用工作区输入、模型能力与客户目录公开查询；HTTP/RPC/MCP 统一经过 access；不依赖 T3 HTTP 实现                                                                                                                        | `access.test.mjs`、`t3-project-memberships.test.mjs`、`t3-workspace-scope.test.mjs`、server `rpc.principal.test.ts`            |
| 工作区：[workspaces.mjs](../agent-demo/t3-adapters/workspaces.mjs)、[workspace-http.mjs](../agent-demo/t3-adapters/workspace-http.mjs)                                                                                                           | authoring 拥有当前来源、原件及输入引用；project-workspaces 拥有源码缓存、外部发布内容、任务和包；异步任务归服务端                                 | 会话经 captureAgentInput/readInput* 捕获和读取每轮资料；部署经 startDeploymentPackages 固定 Git；清理经公开引用保护接口                                                                                              | `t3-workspaces.test.mjs`、`t3-workspace-scope.test.mjs`、`t3-project-memberships.test.mjs`                                     |
| 技能：[skill-library.mjs](../agent-demo/t3-adapters/skill-library.mjs)、[scoped-skills.mjs](../agent-demo/t3-adapters/scoped-skills.mjs)、[skill-library-http.mjs](../agent-demo/t3-adapters/skill-library-http.mjs)                             | `t3/skill-library-v2/index.json` 与不可变版本目录；SQLite 仅协调该库写锁；技能分配、停用、撤回与会话快照由技能模块管理                            | 复用 YAML、ZIP、安全文件读取；平台技能与客户本机技能分开；发现、标签与正文读取使用同一授权版本                                                                                                                       | `t3-skill-library.test.mjs`、`t3-scoped-skills.test.mjs`、`t3-skills-management.test.mjs`、Web `skillLibrary.test.ts`          |
| 资料、附件及成果：[resources.mjs](../agent-demo/t3-adapters/resources.mjs)、[business-tools.mjs](../agent-demo/t3-adapters/business-tools.mjs)、[business-documents.mjs](../agent-demo/t3-adapters/business-documents.mjs)                       | `t3-business.sqlite` 的报告与成果；附件元数据及范围由 access/T3 各自管理，工作区文件由工作区管理；解析进程只接收已授权字节                        | 经 access 校验私有受众，调用工作区、技能及报告公开读取；文档解析复用现有 worker，不向前端暴露宿主路径                                                                                                                | `t3-resources.test.mjs`、`t3-business-tools.test.mjs`、`t3-business-documents.test.mjs`、`agent-demo-attachments.test.mjs`     |
| 发布与部署：[deployments.mjs](../agent-demo/t3-adapters/deployments.mjs)、[deployment-http.mjs](../agent-demo/t3-adapters/deployment-http.mjs)                                                                                                   | `deployment-center/state.sqlite` 的项目映射、目标、固定包来源和部署任务；运行版本、阶段、日志与恢复由原执行引擎拥有                               | 调用 access、工作区公开包读取及 `src/deployment.mjs`；不让模型或 UI 直接控制 Agent；后台领取同样核验权限                                                                                                             | `t3-deployments.test.mjs`、`deployment-workspace-source.test.mjs`、`deployment-lifecycle.test.mjs`、`deployment.test.mjs`      |
| 部署执行器：[agent/main.mjs](../agent/main.mjs)、[runner.mjs](../agent/runner.mjs)、[static-deployment.mjs](../agent/static-deployment.mjs)                                                                                                      | Agent 本地身份、执行收据、源码与构建缓存、静态版本目录；保持目标串行及未知结果核查                                                                | 只通过既有中心协议领取、汇报及下载；不反向导入工作台、页面或业务授权存储                                                                                                                                             | `agent.test.mjs`、`source-cache.test.mjs`、`build-cache.test.mjs`、`static-build.test.mjs`、`integration-protocol.test.mjs`    |
| 我的电脑：[customer-registry.mjs](../agent-demo/t3-adapters/customer-registry.mjs)、[customer-transport.mjs](../agent-demo/t3-adapters/customer-transport.mjs)、[客户程序](../agent-demo/customer-agent/README.md)                               | 平台记录设备所有权、配对、登记目录、连接代次与可靠收据；客户本机 store 保存本地身份和执行记录，附件缓存由本机 CustomerAttachmentCache 拥有        | 复用 T3 `autoopsRemote` 协议与 HeadlessCodexRunner，附件由 CustomerAttachmentDelivery 经 access.requireCustomerAttachment 授权；客户端禁止打包平台数据库、凭证及业务适配器；平台普通管理员不能取得其他用户设备执行权 | adapters `customer-*.test.mjs`、customer-agent `*.test.ts`、server `Remote*.test.ts`、`customerHttp.test.ts`                   |
| 模型与原生运行策略：[models.mjs](../agent-demo/t3-adapters/models.mjs)、[launcher.mjs](../agent-demo/t3-adapters/launcher.mjs)、[codex-policy.mjs](../agent-demo/t3-adapters/codex-policy.mjs)                                                   | 经过验证的模型目录及宿主启动配置；轮次模型与思考强度沿用户提交值，执行由 T3 拥有                                                                  | 使用外置凭据引用、技能快照和既有原生权限配置；不恢复旧 bridge 或另建轮次状态机                                                                                                                                       | `t3-models.test.mjs`、`t3-native-catalog.test.mjs`、`t3-worker-policy.test.mjs`、`t3-product-profile.test.mjs`                 |
| 个人偏好与导航：[preferences.mjs](../agent-demo/t3-adapters/preferences.mjs)、[settings-preferences.mjs](../agent-demo/t3-adapters/settings-preferences.mjs)、[projectNavigation.ts](../vendor/t3code/apps/web/src/autoops/projectNavigation.ts) | 私有阅读水位、置顶/稍后处理等偏好及用户项目选择；不改变共享执行状态或会话绑定                                                                     | 引用原生时间及 shell 投影；切项目仅改变导航，不能重绑已接受的会话或业务任务                                                                                                                                          | `t3-preferences.test.mjs`、`t3-settings-preferences.test.mjs`、`t3-project-navigation.test.mjs`、`t3-settings-return.test.mjs` |
| 前端业务组合：[autoops 目录](../vendor/t3code/apps/web/src/autoops)、[部署展示公开入口](../vendor/t3code/apps/web/src/autoops/deployment/index.ts)                                                                                               | 页面请求、表单草稿及展示状态；服务端事实只通过客户端合同读取；错误边界保护公共壳                                                                  | 复用 T3 组件及当前路由；部署子模块只经 `deployment/index.ts` 被外部引用，内部不反调页面；请求共享边界不得依赖业务界面                                                                                                | Web `src/autoops/**/*.test.ts(x)`、`runtime-boundaries.test.mjs`、只读 `t3-module-shell-ui.mjs`                                |
| 独立新后端：[autoops 模块入口](../autoops/README.md)                                                                                                                                                                                             | 独立账号、项目、环境、统一授权、审计与升级；运行库与当前线上数据分开                                                                              | 只经 `autoops/contracts` 共享纯合同；不导入旧宿主形成双写或隐式身份回退                                                                                                                                              | `pnpm verify:autoops`                                                                                                          |

现有资源查询和工具连接只按已完成能力展示；上述“资料与成果”不是已实现 Server/MySQL/Redis 自助管理。机柜原型、通用通知、尚未实现的后台功能仍按当前入口与计划区分，不能因模块表出现名称而创建占位菜单。

## 本次收敛的内部边界

- HTTP 仅由 [http.ts](../vendor/t3code/apps/server/src/autoops/http.ts) 装配，按工作区、部署、技能、会话和资料划分 [http/](../vendor/t3code/apps/server/src/autoops/http) 路由。共享身份、业务实例和错误映射属于 context/responses；子模块不能反向调用 HTTP、RPC 或客户接入入口。
- 工作区当前资料公开入口为 [workspace-management.ts](../agent-demo/t3-adapters/workspace-management.ts)，固定文件和任务入口为 workspaces.mjs；[workspace-jobs.mjs](../agent-demo/t3-adapters/workspace-jobs.mjs) 管理任务生命周期，[workspace-files.mjs](../agent-demo/t3-adapters/workspace-files.mjs) 管理受限文件操作，[workspace-packages.mjs](../agent-demo/t3-adapters/workspace-packages.mjs) 调用受限 Worker 打包。发行时须一起携带 workspace-package-worker.mjs；不能只发布原入口而漏掉后台实现。
- 授权的唯一公开入口为 [access.mjs](../agent-demo/t3-adapters/access.mjs)。内部 access-identity 管理登录与会话映射，access-bootstrap 管理宿主投影，access-service 管理现有业务策略，access-runtime 装配配置与 SQLite；项目成员和环境授权内部复用 [project-access.mjs](../agent-demo/t3-adapters/project-access.mjs)。其他模块不得直接引用这些内部实现。工作区与部署服务只在完成授权后操作自身数据；后台任务接受和执行阶段仍校验调用者范围，退出页面不改变任务所属身份。
- 部署中心经 [DeploymentService](../src/deployment.mjs) 的公开用例提供项目同步、目标创建和领取归属查询；[deployment-projects.mjs](../src/deployment-projects.mjs) 是引擎内部实现，业务适配器不直接引用它或读取存储。源码构建由 [RepositoryService](../src/service.mjs) 拥有：部署通过 captureArchive、pinRevision、releasePin、cachedCommitSubject 和 waitForIdle 协作，不改写注入的 builder 方法。captureArchive 在源码锁内完成归档消费，同次构建的单个固定失败不破坏普通下载；消费函数不得重入相同源码的构建、历史或固定接口。
- T3 原生附件通过宿主 [resourceCatalog.ts](../vendor/t3code/apps/server/src/autoops/resourceCatalog.ts) 注入公开读取端口；resources.mjs 只负责业务授权与资料投影，不反向导入 attachmentStore，也不查询其他模块的表。
- 工作区、部署和客户执行等已共享 DTO 归 [autoops/contracts](../autoops/contracts)；[apiClient.ts](../vendor/t3code/apps/web/src/autoops/apiClient.ts) 统一请求和错误，工作区轮询与页面错误由所属 hook/ModuleErrorBoundary 管理。它们不改变 T3 会话执行与恢复来源。

- 工作区页面只组合路由、任务和表单；[WorkspaceFileBrowser](../vendor/t3code/apps/web/src/autoops/WorkspaceFileBrowser.tsx) 适配原生文件浏览与固定版本读取，workspaceViewState 仅供工作区内部共享阅读偏好。技能页面保留选择、对话框与导航，[useSkillLibraryCatalog](../vendor/t3code/apps/web/src/autoops/useSkillLibraryCatalog.ts) 负责目录读取、变更与撤权；旧页面写入结果不能覆盖新页面状态。
- [BusinessRuntime](../vendor/t3code/apps/server/src/autoops/BusinessRuntime.ts) 在现有 Effect 宿主中装配业务生命周期，[business-runtime.mjs](../agent-demo/t3-adapters/business-runtime.mjs) 只协调各模块公开停止/关闭端口。初始化失败同样释放已取得资源；已停止的配置实例不会被惰性读取重新创建。具体排空策略及验收见下表与关闭测试。

## 工作区来源与资料维护验收

本节属于第三步新增能力，不改写第二步已完成基线。产品定义维护在[工作台设计](../examples/project-workbench-design.md#仓库来源与日常资料维护)。

| 公开入口                                                                                     | 唯一数据所有者与调用边界                                                                                                                 | 失败影响与验证路径                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [workspace-authoring/index.ts](../agent-demo/t3-adapters/workspace-authoring/index.ts)       | `workspace-authoring/` 自有 SQLite 与不可变原件；维护来源配置、当前资料、修订、解析及捕获引用。其他模块不能引用 storage/rules 或修改其表 | 原件与收据事务一致；并发修订、同名策略、容量、捕获保护、自动回收、重启恢复及正文重提取由 `t3-workspace-authoring.test.mjs` 验证                   |
| [credentials.ts](../agent-demo/t3-adapters/credentials.ts)                                   | `project-credentials/state.sqlite` 与外置主密钥；只有公开凭证版本引用可被来源保存。现有授权模块独立裁决 use/manage；接口不返回秘密       | 现有库丢失密钥拒绝启动，撤销优先于固定引用；加密、原请求、授权、关闭由 `t3-workspace-credentials.test.mjs` 验证；浏览器不持久化秘密或其可猜测摘要 |
| [workspace-git.ts](../agent-demo/t3-adapters/workspace-git.ts)                               | 无业务表，只负责受限 HTTPS 获取和固定提交；Git 历史随内部版本保留，子目录获取不是权限隔离                                                | 显式源地址白名单、DNS/IP 固定、禁重定向/凭证助手/自动子模块与 LFS、限时/限量；本地真实 Git 夹具见 `t3-workspace-git.test.mjs`                     |
| [workspace-management.ts](../agent-demo/t3-adapters/workspace-management.ts)                 | 组合资料、凭证和既有 workspaces 公共接口；现有队列和版本索引仍由 workspaces 拥有，没有第二份任务状态                                     | 全部来源成功才发布；固定输入保护持续到持久终态，未知请求按原 ID 核对；来源预览有并发和关闭排空；见 management 与 lifecycle 测试                   |
| [workspace-authoring-http.ts](../agent-demo/t3-adapters/workspace-authoring-http.ts)         | 通过 `/api/v1/projects/:id/workspace` 暴露业务动作；T3 HTTP 层先裁决身份、CSRF 和内部管理权限，再读取字节                                | 声明长度超限返回 413；无长度流超限可能关闭连接，此时客户端保留原 ID 核对。定向真实 Node 端口测试验证未调用写入控制器                              |
| [WorkspaceAuthoringPanel](../vendor/t3code/apps/web/src/autoops/WorkspaceAuthoringPanel.tsx) | 组合 T3 文件浏览、SettingsRow、Menu、Dialog；当前资料与固定版本共用公开阅读恢复 hook；凭证明文仅留当前表单内存                           | 原请求恢复、切项目、撤权、迟到结果、上下文不变、滚动与响应式分别在 Web unit/browser 测试覆盖                                                      |

组合回归使用真实临时 SQLite、PDF/DOCX 解析、固定文件、队列和 ZIP Worker；双仓来源与单仓服务上下文生成的 ZIP 解包后执行夹具构建，旧会话读取固定 PDF，外部二进制必须复核。Git 网络端口使用隔离传输夹具，不把它计作远端私有仓库已通过。

本批扩展 Node 适配器独立严格 TypeScript 门禁。仅独立 Node 模块标注原生 API 的 Effect 诊断范围；T3 内部仍保持原 Effect 规则，HTTP 继续使用 Effect/Schema。公共文档 Worker 对全部调用方合计最多两个在途任务，忙时明确可重试，不能无限派生解析进程。正文提取失败保留原件，管理者可按原件修订显式重试；重试本身有原请求收据，不改变资料修订或重复创建版本。资料所有者在写入、解析完成和捕获释放后自动清理无引用原件，保护所有项目当前引用、活动捕获及在途解析；清理失败可后续或重启重试，不把已成功写入误报成失败。

发行须复制公共 SQLite 基础文件及合同，同时保留原动态文档依赖。`verify-t3-workspace-release.mjs` 从实际发行目录加载新增服务，在独立临时数据中上传与更新资料、捕获每轮输入并验证旧输入保留和真实源码打包，不能借开发目录掩盖缺依赖。新目录和密钥必须纳入原有数据备份；程序回退继续使用当前业务数据，不用旧备份覆盖新上传资料。

### 本批新增能力验证（2026-10-23）

| 证据层次           | 实际结果                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 检查与回归   | `check:runtime`、网页构建、实际 T3 Worker 构建、`verify:autoops` 通过；Node 全量 458 通过、1 项 Linux 内核锁条件跳过，收尾后资料所有者 19 项和 management/lifecycle 12 项再次通过；Server 114 通过、2 项未配置真实 Codex CLI 的原有探测跳过。Web 最终结果见本批提交对应 CI |
| 真实公共 HTTPS     | `octocat/Hello-World` 的默认分支固定到 `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`；完整获取、README 读取与三条历史通过。私有认证仍只使用隔离传输夹具，未验证真实远端凭证                                                                                                   |
| 本机隔离 UI 写流程 | 上传两份资料、阅读滚动 780 → 刷新 780、文本编辑、同名另存、移动、删除、目录建立/删除；配置公开 Git 来源后真实生成版本 `b856be70-7747-4532-930d-f631032d05ad`，页面选择该版本并核对源码提交及上传资料                                                                       |
| 未知结果与解析恢复 | 上传服务端已保存后丢响应或停止传输，界面保留原请求，核对后恢复；每次仅一个 POST 和一个文件条目。坏 PDF 显式重提取后仍准确返回 `PDF_INVALID`，原件摘要与内容修订不变，保留下载                                                                                              |
| 页面与交互         | 通过产品外观设置验证浅深色，1440×900、390×844、1440×420 的当前资料/来源页面及上传/来源弹窗；长路径、短窗内部滚动、菜单、Esc 和焦点恢复分别记录。静态截图不替代上述真实写入证据                                                                                             |
| 本机服务重启       | 使用新 Worker 重启隔离网关与服务，资料修订 9、两个固定版本及生成请求的原收据前后深等一致；没有操作生产服务或使用生产数据                                                                                                                                                   |
| 发行目录冒烟       | 候选包 4223 文件，复用未修改的客户 ZIP；从实际候选目录加载新模块，在独立数据内上传原件、生成固定版本并完成真实 ZIP Worker 校验。未把本机校验称为 Linux 原生依赖或生产部署验证                                                                                              |

无凭据真实证据位于本 worktree `.deployment/workspace-authoring-evidence/`：`public-git-result.json`、`restart-result.json`、`ui/fixed-selection.json`、`ui/real-ui-theme.json`、`ui/unknown-extract.json`；最初定位与断言错误的报告保留，不计入产品失败或通过。早期 `fixed-version-generated.png` 截于轮询完成之前，只显示旧示例，不能证明新版本；以 `fixed-version-actual-selected.png` 和对应 JSON 为准。

### 测试服务器部署与用户仓库（2026-10-23 至 24 日）

应用提交 `71d1b3b21750b033d68cdb87f6c8ac6b9781d251` 已部署到 `192.168.31.157:28887`，完整发行和恢复配置见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。对应 [Linux 运行链路 39979040966](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39979040966) 与 [AutoOps 质量检查 39979040864](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39979040864) 均通过：Node 468、Server 114（另 2 条件跳过）、Web 207、客户 17、独立后端 21；Markdown 定向三组 179/41/20，另 88 项非本门禁目标跳过。

服务器从实际 Linux 发行目录分别完成原件上传及固定版本生成、既有基线 ZIP Worker 隔离冒烟，真实切换网关与 Worker 后健康、HTML 字节及原业务数据保留均通过。仅在 `p-autoops` 使用正式 API 保存 `coco-ari/travel-map` 和 `coco-ari/ai-gateway` 两个公开来源，固定版本 v003 `7b42cc81-563f-4560-800a-7bc814ce31fa` 的完整 SHA 与配置一致，实际 package.json/README 读取通过；旧两个版本及摘要保留。首次失败记录保留，同期服务器直连 GitHub HTTPS 超时；网络自行恢复后确认原任务失败才显式新请求重试；没有改网络或降低 Git 安全边界。生成成功后验收脚本误读不存在 README 的错误保留，并以实际存在路径只读续验原任务。

线上浏览器只读验收 5 项通过：两来源完整呈现，实际展开目录并打开 README/package.json 原生预览，选择 v003 与核对两完整 SHA，首次失败任务历史，以及浅深色 1440×900/390×844 页面；页面错误与被拦截业务写入为 0，来源数据前后深等，外观偏好已恢复。真实保存来源和生成版本由 API 写入记录证明；静态截图与交互证据分开，不把浏览证明作写流程通过。

新增数据完成独立 cgroup 下的一致性检查点：15 个非空 SQLite 与业务文件归档包含新增资料/凭证库及 0600 默认主密钥；同程序重启后修订 2、两个来源、新旧固定版本和原成功/失败收据均保留，其他四项服务 PID 未变。程序回滚预检通过；未实际执行程序降级或整库恢复。证据为 `checkpoint.log`、`rollback-check.log`、`after-checkpoint-import.json` 与 `ui/report.json`。

证据为 `.deployment/workspace-authoring-deploy/verify.json`、`switch.json`、`seed-repositories.json`、`retry-repositories.json`。真实远端私有 HTTPS 凭证、有效 PDF 的原生浏览器插件呈现未在本批实测；没有调用真实模型执行新资料问答，也没有执行两个用户仓库的脚本或部署其应用。既有第二步的生产证据不替代这些新增能力的验证。

## 自动对话标题默认中文（2026-10-24）

标题继续由 T3 `provider-core` 的公开提示词生成，并经原生标题服务与命令保存。首次生成、手动重新生成共享简体中文规则，保留品牌与文件名，用户明确指定标题语言时遵循指定。旧英文标题不强制保留；生成失败时识别中英文占位结果并保留已有名称，不批量翻译历史或改写消息。

提示词/提供方定向 61 项、原生标题服务和 Codex/Claude 67 项、中文门禁 64+12 项、运行类型及 Worker 构建通过；原生服务回归纳入 `test:runtime:language`。模拟回归与真实模型输出分别验证，公网正式 RPC 已将独立验收对话生成为“说明 client.ts 导出类与构造”且正文不变。网页英文提问的新对话自动命名为“Git 分支与提交的区别”并正常完成。实际发行、原始收据及恢复点统一见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

## 源码更新故障与手机阅读修复（2026-10-24）

线上输入 `dabba354-4829-4ad0-ab8d-bb30635eeffa` 在 Git 查询超时后生成空源码集合，但同一来源的已同步完整源码仍在服务器；失败影响被错误扩大到本轮读取。当前资料编排改为仅沿用同一项目、同一当前来源配置下最近同步成功的内容，记录真实 SHA 与 `sourceWarnings`，没有可用内容才记录 `sourceErrors`。目录选择和新轮共用公开的可用源码判定；来源变更、撤权、取消及完整性失败不能放宽读取。同步记录的提交和版本成对保留，抓取新提交失败不会把新 SHA 配到旧文件。原输入仍固定，部署与对外生成仍严格要求本次来源成功。

手机网页复用 T3 `ChatCanvas`、`MessagesTimeline` 和 `ComposerSurface`：已有对话在窄屏中将输入区纳入画布的纵向布局，正文视口结束于输入区上方；相应调整原生分页滚动、空态和回到底部的避让高度。桌面与新对话居中布局不变，未添加第二套输入或滚动状态机。

本机工作区/Git/工具定向回归 34 项通过，随后新增来源删除及撤权场景，当前资料最终 22 项通过；MCP JSON 合同 4 项通过，`check:runtime`、网页与实际 Worker 构建通过。候选构建使用线上只读数据验证浅/深色、390×700、390×500、1440×900 的正文与输入边界、草稿输入、回到底部、模块菜单 Esc 与焦点恢复；无模型提交或业务写入。首次菜单用例误按 menuitem 查找原生 Combobox，修正为 option 后通过。证据保存在 `.deployment/workspace-mobile-fix/`。实体 iPhone 键盘、浏览器栏动态收缩与流式阅读位置未重测。

应用 `90cea0a6` 两项 CI 均通过并已完整部署，公网六组尺寸/主题交互复验、HTTPS/WSS、健康及数据保留通过。实际独立对话再次发生 Git 超时，但输入仍包含两个仓库、无 sourceErrors；模型成功读取 `client.ts` 的 705 字节原文并给出与正文一致的类名、必填参数和构造函数分析。本次读取不依赖历史消息中的显式引用，直接使用新轮当前输入。实际提交、原始收据、恢复点与未测范围统一见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

## 当前资料与部署来源拆分（2026-10-24）

本批按用户确认的新规则改造，部署状态以下方发行记录为准，未用既有第二步证据代替本批验证。

| 所属模块       | 公开协作与失败范围                                                                                                                                                                                                                    | 本批验证与待核实边界                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 当前资料及 Git | workspace-management 的 captureAgentInput、readInput* 和 sync；原件、源码缓存、引用保护均由工作区拥有。Git 网络故障沿用当前配置下已同步源码并记录 sourceWarnings；确无可用源码才记录 sourceErrors，文档仍可读，不把旧提交冒充远端最新 | 本机 Node 486 项中 485 通过、1 条件跳过；覆盖每轮更新、原请求重复、缓存复用、网络失败、撤权及取消；线上另记 |
| 原生运行与授权 | thread-inputs 调用工作区公开接口，access 持久 run→input 与已验证的历史引用；T3 仍拥有队列和恢复。业务工具必须显式 inputId，迟到调用不会读下一轮                                                                                       | 定向覆盖重启、迟到、外部范围、引用及子任务；真实模型运行另行记录                                            |
| 部署源码       | startDeploymentPackages 在既有队列中固定所选仓库 SHA 与各服务上下文；部署适配器校验同一清单，不依赖日常版本                                                                                                                           | 部署 Node 定向 17 项、浏览器 16 项通过；多仓、上下文、原请求核对与排除上传资料已覆盖                        |
| UI             | 当前文件/源码来源、Agent 范围、部署来源分别组合 T3 原生面板、工具栏和 Dialog；没有常驻整套版本选择器                                                                                                                                  | AutoOps Web 37 文件 239 项通过；后续定向 28 场景、unit 15 项及类型检查通过；发行页面另记                    |
| 历史清理       | 管理入口先预检，再由 store.pruneVersions 处理；access 提供旧引用，工作区保护当前、输入、未知任务和源码包依赖；不跨模块删表                                                                                                            | 已备份并实际删除 3 个无引用旧版本；保留当前 PDF、Git 来源及 v001 的会话、源码包、外部资料依赖               |

本批本机已通过运行边界与类型门禁、实际 Web/Worker 构建、Server 116 项（另 2 条件跳过）和独立后端 21 项。浏览器回归通过沙盒外授权运行；最初 1 项完整按钮名定位失败修正后定向复验通过，未放宽业务断言。Linux CI 与线上实际业务结果分别在发行记录中说明。

本批应用提交 `b6e1ba4e` 已完整部署到测试服务器，发行身份、服务配置、备份及程序回滚路径以[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)为准。该提交 Linux CI 通过 Node 492、Server 120（另 2 条件跳过）、Web 247、客户 17、独立后端 21；Markdown 定向三组 179/41/20，另 88 项非本门禁目标跳过。macOS 构建与定向回归、Linux CI、服务器隔离冒烟、真实业务操作分别记录。

真实资料同步已完成：两个既有仓库按默认分支获得完整 SHA，当前目录同时包含源码与上传 PDF，PDF 原件摘要和正文不变，同一同步 requestId 返回原任务。网络失败曾暴露捕获状态未释放，已修复并用原请求核对相同失败；未知结果仍保守保留。真实模型还暴露资料列表包含嵌套 undefined 的 MCP 编码错误，已修复并新增真实 CallToolResult JSON 合同回归。升级后的同一专用会话连续两轮实际调用 list_project_materials 与 read_project_document 均成功，inputId 各不相同，PDF 正文一致；本轮 Git 解析再度超时时，README 工具调用明确失败且未回退旧源码。原生工具完整结果保存在 live-inputs-final.json，结束后仅清理了本次专用会话。

部署源码包分别实际尝试默认分支和已同步固定 SHA：前者以 WORKSPACE_GIT_TIMEOUT 失败，后者在拉取阶段以 WORKSPACE_GIT_FAILED 失败，均没有生成部署包；按各自原 requestId 核对仍返回同一失败任务，没有重发或覆盖。不能把 Linux 隔离 ZIP Worker 成功当作本次用户远端仓库打包成功；网络稳定后仍须补做成功生成、清单及下载验证。验收脚本最初把两种失败都预期为超时，已按实际代码分别核对，未弱化产品成功标准。证据为 source-package.json、source-package-fixed.json 与 verify-final-data.json。

线上 UI 已实际验证浅深色、1440×900、390×700 与 390×480 短窗口、长名称与路径、来源菜单、弹窗内部滚动、Esc 焦点恢复及空 Git 引用的明确阻止。部署页独立选择仓库、分支/标签/SHA 与构建目录，运行版本来源和任务来源分开；最后刷新当前目录并真实打开 README。截图 `ui-current-final.jpg`、`ui-short-dialog.jpg`、`ui-deployment-dark.jpg` 仅证明静态呈现，交互见 `ui-report.json`。

恢复验收发现源码包失败后仍保留捕获引用，可能阻断升级预检；已补充以同项目、原 requestId、操作人与持久失败任务核对后释放的公开收尾。执行中、缺少收据、解析未知、跨接口复用及已持久输入继续保护；重放原请求不重新执行。最终发行中已通过原 GET/POST 收敛上述两条实际失败捕获，pendingCaptures 归零、原任务标识与错误不变；对应 current 16 项、management/lifecycle 12 项及严格 Node 类型检查通过。取消或重启标记为 interrupted 的捕获目前仍保守保留，不能把状态落盘当作底层 Git/Worker 已排空；这条独立收敛入口尚待实现，不把它与未知结果混称已完成。

最终数据检查点及同程序重启已通过：15 个非空 SQLite、业务文件、当前原件、输入和收据均保留；程序回滚预检通过且明确不恢复旧数据库。本地部署辅助脚本 29 项检查通过，包含已失败收据与真正活动捕获的区分、跨请求保护和备份失败恢复；这些不是实际程序降级演练。先前预检因旧捕获未释放而停止在停服务之前，其记录保留；修复后通过原请求释放并重新完成验收。

本批未执行用户两个仓库的应用构建脚本或真实发布到部署目标；未实测私有远端凭证。当前 IAB 的嵌入 PDF 插件像素呈现未确认，原件、正文与模型读取分别核验，不把接口成功当作插件呈现成功。Windows 真机、实体手机、公网 HTTPS 和全部 T3 上游测试按用户要求排除。输入元数据目前按引用保守保留；未来自动回收须由资料所有者结合历史/运行/部署引用完成，不引入 TTL 直接删库或重新指向最新内容。

## 工作区操作简化与失败恢复（2026-10-24）

源码同步和默认外部脱敏生成改为直接执行；自定义脱敏规则位于次要菜单，生成后主动作进入复核发布，不自动扩大外部可见范围。移除常驻原理说明和资料修订号，历史异常留在任务记录。继续复用 T3 文件工作区、Menu、Dialog、Toast 和 Alert 槽位；修复恢复提示容器误入图标槽后被压成竖排的问题。

资料模块仍拥有来源配置、当前同步状态与捕获收据，工作区任务模块拥有执行终态。客户端自动读取原收据：失败准备会结束待确认状态，后续用户操作可以使用新标识；网络结果未知时只查询并保留原标识，重试仍先查后发。自动查询限三次，网络重连或回到页面后继续；切项目、换账号或卸载后的迟到结果不触发旧页面动作。完整输入、上传文件和凭证秘密不进入浏览器持久存储。同步状态保留稳定失败码，页面显示可处理的简短原因。

线上故障调查确认两个操作曾以 `WORKSPACE_GIT_TIMEOUT` 结束，旧 UI 将服务端 5xx 统一留作待确认，必须由用户手动核对才解锁。测试服务器的两个已配置公开仓库随后在独立受限 cgroup 中均成功解析并完整拉取；未改变 HTTPS、DNS 固定、凭证、重定向和来源允许列表策略。应用部署及实际业务重试结果以现行发行记录为准，不把连通性探测称为业务同步完成。

本机 `check:runtime`、网页及实际 Worker 构建、后端 current/Git 25 项通过。AutoOps 前端门禁共覆盖 265 项；首次两个新增整页用例误把原生单选切换器当作普通按钮，修正选择器及移动侧栏操作后，最终受影响四文件 42 项全部通过，其余 223 项已通过且未受后续修改影响。新增恢复与错误映射文件定向 lint 通过，`git diff --check` 通过。新增用例实际点击一次同步/外部生成、自动确认失败和保存结果、换项目后的迟到收据，并在 390px/1440px 验证提示正文宽度、菜单 Esc 与焦点恢复。证据在 `.deployment/workspace-flow-fix/`；模拟请求不代替部署后的真实仓库操作。

应用提交 `6c726034` 和最终菜单调整 `db9a9968` 的两项 CI 均通过；最后调整另复测整页浏览器用例 15/15。Linux 完整发行清单、原生 CLI、隔离输入与打包 Worker 通过后，已完整部署 `db9a9968`。真实浏览器单次点击同步两个公开仓库、生成外部资料均成功；新外部 PDF 待复核，未执行发布。最后升级后再次核对成功收据、两个来源、原 PDF 摘要和历史保留。浅深色、桌面、390px 窄屏短窗口、菜单/弹窗与焦点实际验证结果及唯一恢复配置见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)；未改变 Git 网络安全策略，也不保证外部网络永不超时。

## 工作区资料页排版（2026-10-24）

按已确认方案复用 `ModuleHeader`、`FileBrowserPanel`、`ReadOnlyWorkspaceFiles` 与原生 Menu/Dialog，合并标题和主要动作，移除根目录的重复标题及重复刷新；任务记录、新建对话、目录和当前文件操作在菜单内保留原权限。新增 `toolbarStart` 槽承载子目录路径，资料页的 `onRefresh` 同时更新文件和所属资料控制器；不跨模块修改状态。未选文件不占用空预览，文件打开后沿用 T3 分栏和窄屏返回。

`check:runtime`、网页构建、三组相关浏览器回归合计 35 项通过；最终路径居中调整复测整页 17/17。实际部署先验证 `a4a0479e`，再发布最终应用 `5ceb677d`；两项 Linux CI、发行校验、原生 CLI、隔离资料输入与 ZIP Worker 均通过。线上浅深色、桌面与 390×480 窄屏、目录搜索、预览/返回、内部滚动、菜单/弹窗及 Esc 焦点恢复通过。文件区增加 81px，子目录路径与搜索垂直对齐，页面无横向溢出。业务数据仍由原模块拥有；本批未提交上传、新建目录、同步或对外发布，既有真实写流程证据不改称本批执行。

布局唯一规范见 [T3 UI 操作简洁性](../examples/t3-ui-standard.md#操作简洁性)；实际发行、数据保留、恢复点、截图和未测边界见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

## 新对话文件引用修复（2026-10-24）

新草稿的当前资料查询没有 `workspaceVersionId`，URL 参数读取返回 `null`，而授权合同使用 `undefined` 表示不指定历史版本；原实现错误查询空版本并将异常映射为通用资料拒绝。仅在资源目录边界归一缺失值，继续通过公开授权与当前输入接口，保留实际无效版本、未发布版本、环境和内部/外部范围校验。

两个新回归在修复前均以 `WORKSPACE_NOT_FOUND` 失败；修复后资料与当前工作区 26 项通过，覆盖源码/上传资料候选、目录、固定原文、更新后新输入、外部已发布内容及撤权拒绝。旧固定版本测试中“必须提供版本”的断言按当前资料合同更新，空版本与重复范围参数仍拒绝。`check:runtime`、实际 Worker 构建及两项 Linux CI 通过，已部署应用 `424f6b35`。

线上新草稿实际完成 `@` 根目录、中文目录 Tab 补全、上传 PDF 标签、Git README 标签和正文预览；未发送模型请求。PDF iframe 空画面单独保留为未确认的渲染结果，不据此扩大本次选择故障的完成范围。具体发行身份、数据保留、恢复点与证据统一见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

## 引用文件分析链路修复（2026-10-24）

真实失败会话的用户消息只有原生 Markdown 文件标签，`context` 为空，`t3_thread_input_references` 也没有记录；MCP 因而拒绝读取选择器产生的输入。本轮 Git 超时又使重新捕获的源码不可用。先前的选择与预览验收没有覆盖发送后的读取，不能视为分析链路通过。

宿主适配复用锁定 T3 的文件标签解析与消息上下文合同，在首次发送、继续发送和编辑待发消息的授权及原生持久化入口补齐明确引用。T3 拥有消息历史，access 通过 `retainInputReference` 保留引用身份，资料模块拥有原件；`requireContext` 和 `readForThread` 继续裁决范围与当前权限。工具使用本轮输入身份，文件路径保持用户选择时的身份，不能把旧内容冒充当前最新资料，也不以同步失败放宽授权。

macOS 34 项资料/权限回归、9 项消息入口测试、`check:runtime` 和实际 Worker 构建通过；隔离测试覆盖新轮 Git 失败仍可读取已选原件、未发送引用和撤权拒绝。应用 `17ea104c` 两项 Linux CI 通过并已部署。线上独立会话 `bbcb5da1-b5df-49fe-9cb2-60f24d30dcd4` 通过实际选择 `client.ts`、发送分析、继续追问两轮模型操作；两次 `read_project_material` 均 completed，分别使用不同本轮 inputId 读取同一所选原件，正文 705 字节、SHA-256 `4eebe4a6fdb78582a66012a8c469b93df173d9d43fa198f6cc04caa39ca18fd9`。实际答案中的 `ClientOptions`、`AliyunBailian`、构造函数与 `apiKey is required` 均与工具正文一致。

本次线上两轮 Git 获取正常；Git 超时条件由隔离回归验证，未人为切断线上网络。原失败消息未重写，继续原失败会话时须重新选择文件发送一次，之后可正常追问。编辑待发消息与撤权仅由自动回归覆盖，未在用户会话中执行。发行、数据保留、恢复点统一见[现行部署记录](../examples/agent-demo-t3-deployment.md#当前验证发行)，本地证据为 `.deployment/reference-read-fix/analysis-evidence.json` 和实际页面截图。

## 技能管理布局与操作精简（2026-10-24）

沿用 Skills Manager 1.43.0（`7a221921`）的卡片分配机制，以及锁定 T3 的 `ThemeSearchSection` 卡片、`WorkspacePageContainer`、原生 Toggle/Popover/Dialog 和满高文件预览。规则与业务适配差异统一维护在 [T3 UI 规范](../examples/t3-ui-standard.md#技能中央库适配)。本批只调整管理页：侧栏移除常驻说明，卡片保留助手与当前项目一键分配，其他项目通过搜索浮层管理；文件详情合并返回与版本选择，去掉重复名称和正常状态徽标；导入与分配提示缩短，外部资料可见性提醒随范围选择显示。

数据所有者仍为技能库服务，页面通过 `loadSkillLibrary` / `changeSkillLibrary`、文件源公开接口协作；无新增存储或跨模块私有状态访问。新分配保持最新版本/内部范围，恢复原分配保留版本与范围，取消项目分配恢复助手继承，单独停用仍能阻断继承。权限、受限版本、错误、刷新锁与撤权清理均保留。

macOS Web 类型、网页构建、技能组件及目录隔离定向回归 10/10 通过；隔离实例实际管理验收 12/12 通过，涵盖正文/ZIP 导入、助手及当前项目快切、项目搜索浮层、旧分配版本与外部范围保留、升级、停用/校验/错误、受限版本和撤回。实际整页操作覆盖浅深色、1440×900、1440×560、390×844 触屏模拟、长标题与文件、内部滚动、菜单与弹窗 Esc、焦点和返回阅读位置。另有项目筛选撤回与重新分配验收 1/1 通过，共 13 项真实管理验收；切换顶部项目后快捷目标、其他项目搜索及 Esc 返回也已实际核对。临时 UUID 技能及分配全部清理，既有目录未改，页面无未捕获错误。证据：`.deployment/skill-layout/management/report.json` 与截图；组件回归见 `browser-regression.log`。

隔离运行器配置为 `/usr/bin/false`，完整脚本中的问答技能选择因此不可用；管理页定向模式显式记录未验证该路径，不将其计入通过。未新增模型调用、真实客户设备、私有 Git 导入或生产权限写入验收。应用 `995e53b6` 两项 Linux CI 通过并已部署，线上卡片、项目搜索、文件详情及返回只读复核通过。部署身份与数据保留以[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)为准。

## 界面中文与工作台用语（2026-10-24）

本批沿用锁定 T3 的工具记录、连接诊断、状态 Alert、设置及主题流程。内置工具来源摘要改称“工作台工具”，已知操作继续显示具体动作，浏览器和设备工具动作补齐中文；对话操作去除 T3 前缀。工具分组的失败标记补充检查带来源的调用，混合成功不能掩盖失败。只改展示，不改历史记录、工具协议、模型名称或权限。

对话服务断开与重连使用中文；连接诊断继续区分设备离线、认证、超时、服务异常与真实 T3 Connect 通道故障，原始原因和追踪标识保留。平台模型服务给出中文提示，原始错误可展开；用户无需进入上游运行器配置。常规设置、开源入口、通知无障碍文案和技能执行环境说明同步整理。内置主题显示“默认”“柔和”，存储 ID、颜色与偏好不变；署名、许可证及兼容格式的真实产品名称保留。用词权威来源仍为 [T3 UI 规范](../examples/t3-ui-standard.md#中文界面规范)。

macOS Web 类型检查、网页构建、36 项工具摘要/连接诊断/模型状态回归通过。新增 `test:runtime:language` 纳入完整运行门禁；旧上游测试中未参与本批的英文快照不作为全部通过声明。独立英文浏览器实测 6 组流程：中文模型错误与原始详情、常规设置、主题导入弹窗与 Esc 焦点恢复、浅深色 1440×600 和 390×480、断网提示与恢复联网后的自动重连。9 张截图及真实操作记录在 `.deployment/ui-language/browser/`，无未捕获页面错误、业务写入或模型调用。隔离运行器为 `/usr/bin/false`，本批不将其视为模型可用性验证；真实模型菜单、常规设置与主题已在线上只读核对。应用 `b033e839` 两项 Linux CI 通过，完整发行、实际网页与目录、数据保留、服务健康及程序回滚预检通过；Worker 同步重新构建。未改宿主寿命、断线策略或自动重试间隔。

## 顶部导航直接切换（2026-10-24）

沿用锁定 T3 的 `WorkspacePageHeader`、原生 `ToggleGroup`、`Combobox` 与 Sidebar，保持 52px 单行公共框架。项目选择器按名称收紧并限制长标题宽度；桌面直接展示问答、工作区、部署、技能库，低频模块进入紧邻的“更多”，进入后显示当前模块名。没有低频模块时不显示空菜单；窄屏通过一个模块菜单访问全部授权入口。设置、外观、归档和退出保留侧栏入口。唯一布局规范见 [T3 UI 规范](../examples/t3-ui-standard.md#问答公共框架与跨模块一致性)。

公开导航注册表继续拥有模块定义，`autoOpsAreaAvailable` 裁决入口呈现，原生路由、草稿与会话仍拥有项目归属；未修改服务端权限、执行绑定或业务存储。macOS Web 类型、网页构建、199 文件边界扫描与 17 项项目导航回归通过。隔离浏览器通过 7 组真实操作：四个常用模块与原草稿返回、项目切换与历史/刷新、空菜单隐藏、侧栏设置/归档/退出入口、浅深色下 320–1440px 与短窗口、长项目名、菜单键盘与 Esc 焦点恢复。长项目名只替换浏览器响应，未写项目资料；本地未启用客户设备，部署后另在真实启用环境只读验证“更多 → 我的电脑”、当前模块名称与窄屏完整菜单，侧栏设置及返回入口可达。应用 `2eb08131` 两项 Linux CI、完整发行校验与程序回滚预检通过，实际目录、网页摘要及数据保留已核对。

证据在 `.deployment/topbar-direct/`。本批验证导航与布局，未发送模型请求或执行管理写入；隔离运行器为 `/usr/bin/false`，其状态提示保留，不计为模型运行通过。相关旧验收脚本同步入口名称和设置路径，未重新执行全部脚本或 T3 上游测试。实际发行、数据保留与恢复配置仍以[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)为准。

## 技能库导航与卡片优化（2026-10-24）

本批只修改技能管理呈现：侧栏补齐图标，名称改为“全部技能、助手分配、项目分配”；卡片复用 T3 ThemeSearchSection 的图标底座，将名称和简介集中在头部，分配区使用分隔线及原生 compact/outline Toggle。共享页面壳、两列密度、弹层和满高文件详情保持原有流程；唯一规则见 [T3 UI 规范](../examples/t3-ui-standard.md#技能中央库适配)。未修改技能名称、内容、数据、业务接口或分配规则。

macOS Web 类型检查、UI 构建、199 文件模块边界通过；本地隔离实例实际管理验收 12/12、项目筛选撤回与重新分配 1/1 通过。覆盖 Markdown/ZIP 导入、助手和项目快切、旧版本及外部范围保留、停用/受限/异常、浅深色、1440×900、1440×560、390×844 触屏模拟、长内容、滚动、菜单弹窗、Esc 与焦点恢复。仅使用本批 UUID 技能，结束清理且原目录保持不变；没有未捕获页面异常。截图证明呈现，真实请求和交互记录分别在 `.deployment/skill-visual-polish/management/` 与 `project-filter/`。

应用 `b973a0e1` 两项 Linux CI、完整发行清单、原生 CLI、隔离资料与 ZIP Worker 校验通过并已部署。线上只读复核侧栏、卡片、菜单、项目搜索与文件详情，不改用户既有分配。运行身份、数据保留和程序回滚预检见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。本批没有重新执行模型技能调用、真实客户设备、私有 Git 导入或线上管理写入；隔离运行器仍为 `/usr/bin/false`，问答技能选择不计为本批通过。

## 非工作区 UI 修复验收（2026-10-24）

本批从 `a87dd997` 建立独立 `fix/non-workspace-ui-review` 分支，只处理此前审查确认的问答、技能、设备引导和设置问题。合入当前工作区基线时保留每轮使用当前资料、部署独立选择 Git 提交及原任务输入不变的合同。旧版平台版本列表读取已被替代，因此不恢复该请求及其重试；客户已登记工作区和对话绑定保留读取恢复入口。以下为来源分支及合并阶段的验证记录；后续已随应用提交 `b0cda944` 完整部署到测试服务器，发行身份、数据保留、只读冒烟与恢复配置见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

继续复用锁定 T3 的 `ChatView`/`ComposerSurface`、`ComposerCommandMenu`、`SidebarUtilityMenu`、原生 Button/Tooltip/Select/Dialog 和剪贴板帮助方法。业务适配仅提供错误、当前授权目录及项目技能分配语义，没有新增页面壳或设计系统。

| 范围           | 修复与本批证据                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 问答与导航     | 欢迎标题纳入输入区高度计算，短窗口允许内部滚动；项目菜单遵守既有管理能力开关；业务模块与设置共用返回目标判定。隔离实例实际检查浅深色、390×420、390×844、1440×600、长仓库名、菜单 Esc 及焦点恢复，技能页不再显示返回自身的入口。                                                                                                |
| 权限与读取恢复 | 客户目录读取失败后清理模型/技能候选，401/403/404 同时清理设备投影；`@` 文件读取错误明确展示并允许重试，错误状态放行 Tab 导航，重试按钮保留 Enter 原生激活；已固定会话仍能重读资料与绑定，未知发送继续核对原收据。浏览器组件测试覆盖拒绝、503、账号切换重挂载后的迟到响应、读取恢复及不改变绑定；不把模拟响应称为线上撤权实测。 |
| 技能项目分配   | 完整分配弹窗支持仅在选定项目停用并阻断助手继承，编辑停用记录不会意外启用。隔离实例实际保存后显示目标项目已停用、另一项目仍沿用助手设置；短弹窗内容滚动与固定操作区通过。后端既有继承规则回归 14/14 通过。                                                                                                                      |
| 设备与设置     | 设备复制复用原生剪贴板降级；非回环 HTTP 引导说明 HTTPS 要求及显式测试参数，不自动开启不安全连接；设置搜索不截获输入法组合事件。输入法事件回归与原设备隔离、技能权限组件回归通过；本批未重做真实客户配对或 LAN HTTP 连接。                                                                                                      |

本机定向浏览器用例合计 26/26（含新增 10 项）、客户与技能单元 9/9、React Compiler 2/2 通过；根/Web 类型检查、网页构建、192 个源文件的模块边界检查及 `git diff --check` 通过。浏览器通过沙盒外授权运行独立测试 profile；可视验收使用单独端口和示例数据。模型执行器刻意禁用，其探测错误如实显示，空态截图在显式关闭提示后记录；本批没有执行真实模型、流式/队列/停止、生产写入或部署。截图仅证明呈现，交互与保存分别按上述记录；本地无凭据证据在 `.deployment/ui-review/`。

新增文件的定向 lint 通过；受影响存量文件的定向 lint 尚有 27 项样式及 Effect 依赖等诊断，原基线同为 27 项。完整诊断与基线比较保留在本地证据中，本批不宣称全量 lint 通过。

新增组件用例已接入 `test:runtime:web`，Linux 完整运行结果以本分支提交对应 CI 为准。Windows、实体手机、真实输入法软键盘和完整 T3 上游测试不属于本批已测范围。

合并验证：在 `50b0c475` 当前资料基线上合入 `5c337465` 及其前两个修复提交。macOS 通过 `check:runtime`（196 个运行源文件、无边界错误及全部运行类型检查）、`build:ui`、`test:runtime:web`（42 文件、257 项）和 React Compiler、设置返回、项目导航、技能管理定向 Node 回归（32 项）；调整后的客户目录键盘重试用例 lint 与 `git diff --check` 通过。测试使用与合并树逐文件核对的独立依赖快照，浏览器经沙盒外授权使用临时 profile；证据在 `.deployment/non-workspace-ui-merge/`。同步修正上一条文档提交的表格格式门禁失败。合并阶段未追加整页可视验收或发布，前文来源分支的可视记录不改称线上验证。该合并提交 Linux 运行链路与 AutoOps 质量 CI 均通过；后续部署只读冒烟及未覆盖项另见当前验证发行。

## 工作台原生呈现优化（2026-10-25）

本批沿用锁定 T3 v0.1.1 的 `ComposerControl`、`SidebarMenuButton`、`ThemeSearchSection`、Popover/Dialog 与日志面板。先核对 `DraftHeroHeadline → ChatView`、`scopeSelection → ScopeToolbar`、`ModuleSidebarItem → 各业务侧栏`、`SkillLibraryCard → 分配控制器`、`DeploymentsPanel → DeploymentLogs` 的调用和已有测试，再限制修改在这些呈现组件及对应回归；未改变业务 API、权限、任务状态或轮询所有者。

改造前在真实公开页面及隔离环境确认：项目名称在顶栏、面包屑和新对话中央重复出现；可编辑范围控件实际上未禁用，但采用了更小、更淡的样式；业务侧栏覆盖原生行高；技能分配按钮形成密集边框；部署元数据与日志分成多层工具栏。按 UI 规范调整如下：

- AutoOps 已选项目的新对话去掉中央重复欢迎标题和项目选择，保留公共顶栏及对话路径；原生 T3 和未选项目流程保持原行为。
- 可编辑范围恢复原生 `sm` 控件（14px / 28px）；锁定摘要保留原语义。侧栏恢复原生单行密度，详情行使用统一变体，粗指针点击区最小 44px。
- 技能卡保留原生主题库布局，分配使用紧凑无边框切换按钮；已分配勾选和未分配加号仍可辨识，助手/项目分组有可访问名称。
- 部署页合并工具栏与日志摘要；完整执行器/已确认版本放入“运行信息”。失败、恢复失败、运行中及结果未知仍直接显示，选中任务读取失败时仍可切换任务。

用户体验改善体现在内容空间、可编辑性和操作层级；开发体验改善体现在复用同一组件变体并保持状态所有者；Agent 体验改善体现在明确的语义分组、稳定的控件名称与原有公开调用入口。没有向用户展示请求标识或内部映射。没有删除原有 `aria-label`、表单标签或真实错误提示。

### 核心任务前后步骤

比较起点均为已登录、同一权限/数据、对应页面已打开且菜单关闭。选择和菜单展开分别计步，自动处理不计步。

| 核心任务                   | 修改前完整操作（次数）   | 修改后完整操作（次数）      | 验证                                                    |
| -------------------------- | ------------------------ | --------------------------- | ------------------------------------------------------- |
| 新对话切业务范围           | 打开范围菜单 → 选择（2） | 打开范围菜单 → 选择（2）    | `scopeSelection.browser.test.tsx`；整页菜单与 Esc       |
| 切模块侧栏分类             | 点分类（1）              | 点分类（1）                 | `ModuleSidebarItem.browser.test.tsx`，含 390px 与粗指针 |
| 给助手分配/取消技能        | 点助手按钮（各 1）       | 点助手按钮（各 1）          | `SkillLibraryAccess.browser.test.tsx`，成功/拒绝/重试   |
| 给当前项目分配/取消技能    | 点当前项目按钮（各 1）   | 点当前项目按钮（各 1）      | 隔离环境真实 API 分配后取消，恢复原绑定                 |
| 给其他项目分配技能         | 更多项目 → 选择项目（2） | 更多项目 → 选择项目（2）    | 原选择入口及分配控制器未改；相关技能回归                |
| 打开技能详情               | 点技能名称（1）          | 点技能名称（1）             | 桌面/窄屏实际打开                                       |
| 阅读选中任务结果和日志     | 直接阅读（0）            | 直接阅读（0）               | 成功/恢复失败/未知结果显示；日志视口实测                |
| 切历史任务                 | 打开任务列表 → 选择（2） | 打开任务列表 → 选择（2）    | `DeploymentLogs.browser.test.tsx`，读取失败后切换恢复   |
| 查看阶段/本次任务来源      | 点对应入口（各 1）       | 点对应入口（各 1）          | `DeploymentDialogs.browser.test.tsx` 与日志回归         |
| 查看已确认运行版本来源     | 点来源（1）              | 运行信息 → 查看来源（2）    | 实际打开来源弹窗；连续 Esc 逐层关闭并恢复焦点           |
| 查看执行器与已确认版本摘要 | 直接阅读短版本（0）      | 运行信息，提供完整版本（1） | 低频信息增加一步，换取日志空间；不隐瞒此取舍            |

隔离环境单次分配和取消的点击至可见反馈约 275ms / 274ms，包含控制工具开销；没有做前后性能基准，不能据此宣称速度提升。后台等待与失败核对流程未改变。1440×600 时，部署日志滚动视口约 373px，占部署内容区约 75%；长日志在内部滚动。

### 实际验证及限制

- macOS 的隔离构建目录使用当前工作树源码；`pnpm run build:ui`、网页类型检查通过。工作树依赖软链指向旧检出，直接使用会出现旧合同缺字段，因此采用已有隔离依赖目录，未改锁文件或安装依赖。构建仍有已有大 chunk 提示。
- 单元测试：技能库 3 项、部署/运行状态 22 项、ChatView 编译 2 项通过。
- 六个浏览器文件共 48 个用例通过：`scopeSelection`、`SkillLibraryAccess`、`DeploymentLogs`、`DeploymentAccess`、`DeploymentDialogs`、`ProjectAreasResponsive`。新增侧栏用例另在普通和粗指针环境验证。测试通过外层授权启动独立浏览器配置，未复用或关闭用户 Chrome。
- CUA 实际界面：1440×600、390×600，浅/深色；问答范围菜单、技能详情和分配、部署任务/来源弹窗、Esc 和焦点、失败状态、长名称、横向溢出及日志内部滚动。问答菜单在完整输入器中按 Esc 回到消息编辑区，独立范围组件回到触发按钮；部署弹窗与 Popover 按顺序恢复各自焦点。
- 隔离环境使用真实业务存储与技能 API；部署结果来自模拟 Agent 收据，模型执行器故意不可用，错误保持可见。该验证不代表真实 Java/静态业务发布或模型回复通过。截图仅证明呈现，交互结果单独记录。未执行全部 T3 上游测试，也未进行 Windows 真机或实体手机测试。
- 构建、日志、截图及发行核对证据保存在本次工作树的 `.deployment/t3-ui-alignment-20261025/`；部署实际提交、CI 与数据保留结果在部署记录中另行记录。`main` 能力盘点见[待确认适配方案](../examples/deployment-core-adaptation-plan.md)，不属于本批已实施功能。

## main 部署核心适配（2026-10-25）

用户确认按[完整适配范围](../examples/deployment-core-adaptation-plan.md)实施，旧 Jenkins／脚本直取源码明确退役。继续使用同一 `DeploymentService`、`SourceArchives` 与部署 Agent；没有合并 main、重启旧控制台或启用独立后端身份。下面是本批实现边界，真实发行与业务验收结果以[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)为准。

| 模块                 | 唯一数据所有者与公开协作                                                                                                 | 失败及恢复边界                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务、位置与来源     | 引擎拥有独立 Java/static 服务、位置配置和服务×环境默认来源；适配器经 `projects` 公开用例管理，工作区仍拥有仓库与凭证     | 原有映射基础版本保持 1，独立 `configurationVersion=1` 添加配置与修改收据；未知版本拒绝。配置键冲突、范围变更和活动任务限制由引擎裁决                 |
| 发布与固定源码       | 单次提交先持久原任务，再经 `startDeploymentPackages` 固定所选 Git 提交和构建上下文；包清单、摘要、服务类型与路径必须一致 | 原请求返回原任务，之后修改默认来源或删除仓库不会阻断已接受收据。排空后通过工作区公开只读收据核对完成结果；不把停止接单误报为源码失败                 |
| 执行与运行观测       | Java 发布/重启/回退及 static 原子切换沿用原 Agent；确认版本与目标观测分别投影                                            | 重启使用当前确认版本配置，回退使用历史配置。观测超过 60 秒显示过期；失联、恢复失败、未知结果不能显示为健康或成功                                     |
| 节点与存储           | 引擎拥有注册身份、绑定、能力与存储策略；`deployment-servers` 仅提供安全 DTO                                              | 项目管理员只能操作授权范围；共享节点绑定、全局撤销/删除及存储策略由平台管理员裁决，实际写入事务内重查权限。策略保存不等于 Agent 已执行               |
| 历史与日志           | 引擎拥有分页历史和原源码档案；前端复用原增量日志游标和原生面板                                                           | 清理保护当前版本、恢复基线和活动引用；清理请求幂等。已清理历史返回 410，即使另一版本复用了同摘要档案。界面切范围后迟到请求不能发起下载或清除新区权限 |
| 机器接入与旧下载退役 | 网关只转发专用 Agent 注册、心跳、领取、事件和任务取包，发行校验包含实际 Agent 构建包                                     | 删除旧 latest 路由、浏览器下载页、口令生成/轮换/校验/计数及 Jenkins 示例；版本化清理仅作用于旧下载字段，Git 凭证、Agent 身份和历史不变               |

本批先复现再修复的边界包括：默认源码变化后原发布请求被重复校验阻断；写操作排队期间撤权仍生效；工作区包已完成却在停服排空时误报失败；已清理历史通过共享摘要仍能下载；修改服务目录后页面与源码包校验仍使用旧目录。有效配置现在由引擎同一公开读取接口提供，历史和当前确认版本的配置不随草稿修改。对应最小失败证据和定向回归位于 `.deployment/deployment-core-20261025/`；后端用例分别覆盖原请求参数冲突、事务内授权、排空重启恢复和共享档案引用保护。浏览器另验证清理明确失败与未知结果分开、历史指针刷新和迟到响应隔离。

最终兼容审查补齐两条路径：配置写入的原始提交指纹独立于现行服务目录，先授权并核对原收据，再为新请求验证来源；原字段指纹保留兼容，参数或操作者变化仍拒绝。程序回滚后旧版本可能重新写入退役下载字段，因此每次初始化都幂等清除这四个旧字段，DTO 也防御性排除；真实旧模块写回再升级已先红后绿，未知格式仍拒绝。对应回归分别 49 项与 30 项通过，与其他定向组合重叠，不累计为新的总覆盖数。

核心操作比较使用相同已授权项目、已配置服务/位置和可用来源。次数包含打开菜单、选择及确认，系统固定源码和排队不计用户操作，网络与构建等待单独记录。

| 核心任务                | 修改前                                                                   | 修改后                                                                                              | 验证入口                                                                         |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 使用已配置 Git 来源发布 | 打开源码包 → 确认生成 → 等待 → 关闭源码包 → 发布 → 确认发布，共 5 次操作 | 发布 → 确认发布，共 2 次操作；服务端固定源码并进入同一任务                                          | `DeploymentDialogs.browser.test.tsx`、`t3-deployments.test.mjs`                  |
| 使用已生成固定包发布    | 发布 → 确认发布，共 2 次操作                                             | 发布 → 展开来源 → 选择已有包 → 确认发布，共 4 次操作；默认入口优先常用 Git 发布，明确保留固定包选项 | `DeploymentDialogs.browser.test.tsx`、`DeploymentSourcesDialog.browser.test.tsx` |
| 切换已有位置            | 在旧目标列表选择，共 1 次操作                                            | 打开位置选择 → 选择位置，共 2 次操作；服务与位置分开，支持同服务多个位置                            | `ProjectAreasResponsive.browser.test.tsx`                                        |
| 重启 Java 当前版本      | 原 T3 入口不支持，不能作为 0 次操作比较                                  | 打开更多 → 重启 → 确认，共 3 次操作                                                                 | `DeploymentDialogs.browser.test.tsx`、`deployment-workspace-source.test.mjs`     |
| 检索并复制任务日志      | 浏览器查找 → 输入 → 选择匹配文本 → 复制，至少 4 次操作                   | 输入日志筛选 → 复制结果，共 2 次操作；等待已有游标补齐后才允许复制，读取失败保持错误与重试入口      | `DeploymentLogs.browser.test.tsx`                                                |

用户可直接发布并在对象内查看配置/历史；开发者复用引擎公开接口、已有来源与原生 T3 控件；AI Agent 通过语义明确的表单、动作与持久收据判断结果。三者共用授权与错误合同，不另建状态机，不向普通用户展示内部请求标识。

本地验证：最终 `pnpm test:runtime:node` 共 549 项，548 项通过、Linux 内核锁用例在 macOS 跳过 1 项，无失败。首次受限沙盒不允许本机回环监听，记录 `listen EPERM` 后通过具体测试命令的外层授权重新运行；失败日志保留，不计为业务失败或通过。此前 13 个 Node 文件 142 项以及服务目录相关 68 项是重叠定向证据；浏览器与界面关联单测共 121 项中首轮 120 项通过，唯一日志阶段中文断言修正后，连同日志、仓库版本选择、权限和响应式 4 个文件的 40 项补跑全部通过。历史清理、来源选择、节点管理及日志补读均有真实浏览器组件交互测试。实际 Worker 路由相关 6 项通过，发布历史分页 7 项单测通过，`pnpm check:runtime`、`pnpm build:ui` 和实际 Worker `build:bundle` 通过。发行保护脚本 45 项、真实验收脚本的离线条件检查 12 项通过；后两者不能替代线上切换或真实 Java 发布。以上是 macOS 构建和定向测试，不代表全部 T3 上游回归、Windows 或实体手机验证；Linux 运行与真实业务操作在发行后另记。

### 发行复核与真实业务验收边界

首次 `8b5b9e59` 候选切换时安装脚本返回 503，发行保护自动回到 `27fa5b34`，没有用旧备份覆盖业务数据。已复现打包改变模块位置后资产相对路径失效，改为通过现有启动器资源根传入安装目录；模块移位及真实监听器的 35 项定向回归通过。随后冷启动复核发现另一独立条件：部署监听器原先依赖首次访问部署页面才初始化。实际 Worker 在不打开部署页面时返回网关 503，不能用先读取部署概览的预验替代冷启动验证。宿主现通过原公开接口等待已启用的部署监听器就绪，Effect 层保留先登记清理再初始化的顺序；相关 Node 30 项、Effect 层 2 项通过，覆盖未启用不建库、端口冲突保留其他服务及初始化中关闭收口。空库关闭竞态测试不代表持久任务恢复的全部情形通过。本机重建后的真实 Worker 在读取部署概览之前，安装资源 GET/HEAD 均通过字节核对，类型检查通过；实际发行身份和 Linux 结果以[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)为准。

本批临时 Docker/slirp 验收设施发生挂载传播事故，导致宿主 13 个系统挂载不可见；已受控恢复并逐项核对原文件系统、终端、cgroup 和应用健康，原应用及共享 Docker 进程保持运行，本批临时进程已停止。该隔离启动方案已停用，不能以离线脚本用例通过再次在共享宿主试验。完整事故与恢复证据保存在 `.deployment/deployment-core-20261025/incident-review.md`。初始防火墙摘要包含时间及计数，不能证明事故前后规则语义完全一致；恢复前至清理后的规范化规则稳定，该初始证据缺口保留。

新增入口的真实 Java 多模块构建、发布、重启、回退和失败恢复，以及 static 发布、回退、失败恢复，仍需独立 Linux 测试目标。中心与 Agent 断线后的补报和原收据恢复、节点存储策略实际执行也在该目标验收。本机单测、模拟 Agent、线上只读页面及程序回滚均不能替代这些业务写流程；未取得实际证据前，不宣布四批迁移全部验收完成。

## 可执行门禁

准备 Node.js 24.22.0、根锁定 pnpm 与 T3 锁定工作区依赖；Linux 是部署及完整运行链路 CI 环境。首次安装：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir vendor/t3code --filter "@t3tools/monorepo" --filter "@t3tools/web..." --filter "t3..." --filter "@t3tools/scripts..." install --frozen-lockfile --ignore-scripts
pnpm --dir vendor/t3code/apps/web exec playwright install --with-deps chromium
```

| 命令                            | 覆盖范围                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm check:runtime:boundaries` | 递归发现运行代码、依赖规则与解析覆盖核对；新增子目录自动进入                                         |
| `pnpm check:runtime`            | 门禁文件格式、根脚本语法、根/Web/Server/客户程序类型、运行模块依赖                                   |
| `pnpm test:runtime:node`        | 递归执行根与适配器 Node 测试、运行边界负例；包含原部署引擎及网关测试                                 |
| `pnpm test:runtime:server`      | T3 `src/autoops` 下的实际服务、权限、客户事件及恢复测试                                              |
| `pnpm test:runtime:web`         | T3 Web `src/autoops` 及文件候选错误恢复、设置搜索输入法定向组件测试；不是所有上游 UI 测试            |
| `pnpm test:runtime:language`    | 工具摘要中文、来源失败状态、连接诊断及平台模型服务提示的定向回归                                     |
| `pnpm test:runtime:markdown`    | 共享文件链接解析与原生 Markdown 文件引用、Windows 链接的定向浏览器回归；不覆盖全部上游 Markdown 测试 |
| `pnpm test:runtime:customer`    | 先打真实客户 ZIP，再测客户执行、传输与离开仓库后的分发运行                                           |
| `pnpm verify:runtime`           | 上述检查与测试，并构建当前真正使用的网页；本地与 `runtime.yml` 使用同一入口                          |
| `pnpm verify:autoops`           | 独立新后端的完整检查；由原 `autoops.yml` 保持执行                                                    |

`verify:runtime` 不调用模型、不连接真实部署目标、不执行远端重启，也不构建桌面、营销站或完整上游产品。发布前仍须按受影响范围打包 T3 服务端，并执行真实环境健康、静态文件、数据保留及跨模块交互验收；模拟测试不能替代这些验证。

## 边界检查的准确范围

检查器递归扫描 `agent-demo/`、`agent/`、`src/`、`autoops/contracts/`、T3 Server `src/autoops/` 和 T3 Web `src/autoops/` 的 JS/TS/JSX/TSX 运行源码。测试、声明文件、依赖安装目录、运行数据及构建输出不作为生产源入口；唯一额外排除的 `agent-demo/customer-agent/live-validation.mjs` 是需要真实环境的手动验收程序。它不进入产品分发，客户 ZIP 另有全部分块依赖审计。

静态分析保留类型导入、动态导入和 T3 的 `~`/`@` 路径别名。禁止扫描范围内循环、未解析依赖、前端引入后端/Node、业务服务反向导入 T3 入口、执行引擎反向导入工作台、客户执行带入平台存储、部署内部被深层引用、HTTP 内部被穿透或反向依赖入口，以及共享请求层反调界面。新增业务子目录与文件自动进入扫描；根目录为空、源码漏扫或被停止遍历时必须失败。私有入口规则额外保护 access 内部、工作区后台、部署项目存储及工作区/技能页面内部控制器；共享请求只依赖宿主快照。新增私有边界仍须登记所有者与内部路径，并补合法协作和非法穿透用例；自动发现文件不等于自动推断其所有权。

锁定 T3 其余源目录和依赖包作为外部节点保留直接依赖边，不递归审计其全部内部结构；`web/src` 的历史页面也未纳入本项架构扫描。T3 Web/Server 类型与相关测试继续覆盖实际引用，但不能将本门禁表述为上游全仓架构检查。`Worker` 的文件 URL、运行时路由和 SQL 访问边界还需合同、执行及行为测试，依赖图本身不证明授权正确。

AutoOps Web 全量回归按文件串行执行，保留原 15 秒单例断言预算。Windows 上并行导入宿主依赖曾造成三个用例在模块加载阶段超时；串行运行相同 134 项全部通过，不跳过用例或提高断言时限。该资源安排同步在本地与 CI 的同一命令中。

Windows 上的目录 fsync、POSIX 权限、静态站点符号链接和 shell 构建用例目前存在环境差异；缺浏览器、沙箱写权限及有实际错误的测试必须分别报告。不得为获得绿色结果跳过后宣称完整链路通过，也不能用 Windows 失败替代 Linux CI 的实际结果。

## 当前运行限制与后续收敛

- 当前工作区文件存储按单个服务进程写入；PID 与进程实例标记用于恢复本实例遗留任务，对其他仍存活 PID 采用保守保留。尚未提供多实例租约，不得部署多个共享该目录的写入 worker。
- 本轮业务生命周期已接入 T3 Effect 组合根，但本节代码验收不能代替真实升级。远端已领取的部署和客户动作继续按持久收据核对，中心进程退出不等于远端动作取消或完成；目标主机切换仍要核对活动任务和数据保留。
- 现有部署引擎的聚合存储继续由引擎拥有，未进行全面换库；单实例和现有持久格式是明确边界，不能据此声称所有历史存储已迁入独立后端。
- 共享服务器上安装依赖或验收，必须使用独立 cgroup 的总内存限制并串行执行；只设置 V8 堆上限不能保护线上进程。构建优先在开发或 CI 主机完成，验收只使用隔离数据目录。

## 本轮逐模块验收范围

下表列明本轮改造与沿用边界，具体执行结果以提交对应 CI 为准；不将测试入口存在写成实际通过。没有行为变更的模块只核对必要调用链，不为增加拆分数量改写实现。

| 模块                 | 唯一状态所有者与实际公开协作                                                                           | 必要依赖及失败影响                                                                                        | 本轮实际验证与范围边界                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 登录、项目与环境授权 | 网关拥有登录/CSRF；access 公开门面拥有业务范围与绑定                                                   | 所有业务入口经 access 裁决；身份或共享存储失败时拒绝依赖操作                                              | CI 权限回归；匿名 401、外部部署 403、跨项目 404、旧配置 409 已实测；真实切项目、切身份与迟到响应隔离通过                                                           |
| 宿主与生命周期       | BusinessRuntime 装配 runtime.initialize/drain/close；各模块拥有自身资源                                | 停止接单后先排空再释放；远端任务不能由宿主退出推断结果                                                    | 新版空闲 SIGTERM/重启及数据保留通过，修正 systemd 的正常中断识别；本机真实配置宿主活动 SIGTERM 排空通过；线上远端原任务跨中心重启收据通过                          |
| 工作区               | workspaces.mjs 公开服务拥有版本、文件索引与任务；HTTP 仅调用公开方法                                   | 授权、受限文件操作与打包 Worker；单任务失败保留已发布版本                                                 | 固定包生成/下载、脱敏生成/复核、幂等与越权通过；合法 Git 导入、实际 fetching 阶段取消、失败后显式恢复及旧版本保留通过，见收尾实证                                  |
| 发布与源码           | DeploymentService 拥有配置/任务/记录；RepositoryService 拥有源码和持久格式                             | 经 captureArchive、pinRevision、releasePin、cachedCommitSubject、waitForIdle 协作；源码失败不伪造发布成功 | 真实构建、同请求去重、手动回退、健康失败恢复、恢复失败与显式再次恢复通过；浏览器丢响应、未知态、刷新及原请求核对通过                                               |
| 技能                 | skill-library/scoped-skills 拥有不可变包与授权快照；useSkillLibraryCatalog 拥有页面目录请求            | access 与原生技能目录；读取失败阻止新选择，历史标签不代表当前仍获授权                                     | 真实导入/发现/隔离、固定版本和停用拒绝通过；换版标签缺陷已修复，专项 UI 3/3；真实系统焦点及停用后迟到响应拒绝通过                                                  |
| 资料与成果           | resources/business-tools 拥有业务投影与成果；原生附件仍由 T3 拥有                                      | 经 resourceCatalog 公开读取端口和 access 授权，不穿透附件库；拒绝请求不返回旧资源                         | 真实资料读取、原文复制、固定版本预览及范围隔离通过，原成果保留；当前资料引用发送及跨轮真实工具读取见引用分析修复；真实私有 Markdown/PDF 创建、下载和删除后拒绝通过 |
| 前端宿主与工作区展示 | hostSnapshot/threadScopes、WorkspaceFileBrowser、workspaceViewState 分别拥有快照、范围、文件与阅读偏好 | 统一 apiClient、服务端 DTO 和 T3 公共框架；局部加载失败由模块错误边界呈现                                 | 公共框架 10/10、部署 UI 8/8 基线保留；最终代码阅读跨页/冷刷新恢复与部署提示布局通过，长路径、浅深色、窄屏和短窗口按最终实证范围记录                                |
| 客户本机             | 客户进程拥有目录、凭据、原生执行与待回传记录；中心拥有业务绑定和投递收据                               | 只经客户传输合同协作；断线不释放未知占用、不伪造停止                                                      | 真实 macOS 设备执行、技能、隔离、空闲重启、强制退出原收据核实与活动断线补报通过；专用设备保持配对，未扩展个人目录                                                  |
| 部署 Agent           | 现有 Agent 拥有目标机执行与恢复；中心只接收公开协议收据                                                | Docker/Nginx 与固定源码包；本机失败上报真实恢复状态，中心停止不等于取消远端动作                           | 本轮专用测试目标真实发布/回退/失败恢复通过；真实跨中心重启、未确认事件补报及恢复失败通过                                                                           |
| 模型、偏好与导航     | 原生 T3 拥有模型轮次与偏好；业务模型目录只提供既有能力                                                 | CPA 元数据暂不可达可复用上次目录，执行仍独立验证模型；导航不重绑已接受任务                                | 实际 CPA 技能及内外部资料读取、真实流式上读位置通过；刷新核对原部署任务，跨页及冷刷新恢复固定文件阅读位置通过                                                      |
| 独立 AutoOps 后端    | 独立账号、项目、环境、权限、审计与升级切片                                                             | 仅经 autoops/contracts 共享纯合同；不与当前线上双写                                                       | verify:autoops 对应 CI 通过；未切换线上身份和存储，不把启用新后端列作本轮补建                                                                                      |

关闭配置：AUTOOPS_SHUTDOWN_DRAIN_MS 默认 30000 毫秒，允许 1000–120000 毫秒。它是优雅排空预算，超出后记录未完成模块并协作取消本地工作区任务；部署已经接受的本地落盘仍需完成，不能在后台继续写入时提前关闭数据库。此配置不是整个进程的硬退出上限；最终强停由部署监督器的退出预算负责，重启后仍按持久收据核对远端结果。

## 第二步最终验收

第二步于 2026-10-23 以 `73b119c4` 完成当时已实现的模块和业务流程，不以目录或拆分数量、零依赖为完成依据。逐模块表已经记录唯一数据与状态所有者、实际公开接口、必要依赖、失败影响及成功/越权/异常/恢复证据；本轮真实验收发现的导入容量扫描、原生代码视口、冷刷新阅读恢复和部署提示布局缺陷均已修复并随最终版本发布。

当前应用提交、程序/网页/客户包、摘要、服务配置和恢复点的唯一现行记录见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。下方 b6f25a04、61e9ed11 与更早批次保留各自证据，不能把历史发行或健康接口中的锁定 T3 `sourceCommit` 当作当前应用提交。

| 证据层次           | 最终结果与准确范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向验证与构建     | macOS 21 项相关浏览器定向回归与完整网页构建通过；实际网页、T3 Worker 与客户 ZIP 已构建，未重复未受影响的重型回归                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 最终提交 CI        | [工作台运行链路 39961511719](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39961511719) 与 [AutoOps 质量检查 39961511745](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39961511745) 均通过；Node 415 项、Server 106 项（另 2 项条件跳过）、Web 172 项、客户程序 17 项通过；Markdown 定向三组 179/41/20 项通过，另 88 项非本门禁目标跳过，不表述为全部上游 Markdown 测试                                                                                                                                                             |
| Linux 发行验证     | 5657 文件、61 相对链接和官方同版原生依赖 2038 文件/21 包验证通过；实际 CLI 与隔离工作区打包 Worker 启动通过。证据：`.deployment/step2-closeout/release/verify-73b119c4.json`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 切换与数据保留     | 停止接单并复核平台、工作区、部署及客户收据空闲后备份并切换；沿用原数据，235 个原工作区/技能文件、96 条消息、31 轮运行、289 条轮次条目、17 个会话绑定、3 份成果，以及 1 个客户设备、1 个目录、1 个传输会话、12 个命令和 3 个游标均保留，原部署配置与记录不变；其他四项服务 PID 不变，健康、实际发行目录和 HTML 摘要通过。脚本运行 11.979 秒，不作为精确停机时长。证据：`.deployment/step2-closeout/release/switch-73b119c4.json`                                                                                                                                                  |
| 最初数据复核       | 首批发布前 159 个原文件仍在，157 个摘要未变，两个索引原条目保留；原会话历史、部署配置、源码包及来源保留。后续合法新增记录不作为数据丢失。证据：`.deployment/step2-closeout/release/retention-73b119c4.json`                                                                                                                                                                                                                                                                                                                                                                      |
| 最终线上 UI        | 阅读恢复 2/2：真实固定代码文件滚轮 top=800，跨模块返回与冷刷新均恢复到 800；390×600 浅深色内部滚动和既有 43 字符路径通过，不称超长中文路径已测。部署提示布局 4/4：浅深色 × 1440/390×420，按钮位于提示框内标题下、无横向溢出；布局复验只读，未知响应后的按钮核对操作沿用前批真实流程证据，两份最终报告均无页面错误和业务写入。阅读恢复证据：`.deployment/step2-closeout/ui/workspace-reading-73-final/report.json`；部署提示布局证据：`.deployment/step2-closeout/ui/deployment-pending-layout/report.json`。截图证明呈现，真实滚轮、刷新、切页和点击记录证明对应交互，不相互替代 |
| 最终健康与客户收据 | 最终应用版本、网页摘要和 Worker 健康一致；复核时专用客户设备 connected=1，12 个命令收据为 completed，活动租约、未应用事件和游标差均为 0。证据：`.deployment/step2-closeout/release/health-final.json`；该瞬时状态不承诺客户进程持续在线                                                                                                                                                                                                                                                                                                                                          |
| 原部署请求复核     | 原请求 `db3e6312-22f2-4d4b-aaab-0350128b31ae` 仍对应任务 `7c17f087-035e-40ea-81f4-ab427da76362`，没有因刷新或补丁重复创建任务；证据：`.deployment/step2-closeout/ui/deployment-pending-layout/report.json`                                                                                                                                                                                                                                                                                                                                                                       |
| 程序回滚准备       | 完整一致性备份、可执行程序回滚脚本和 `--check` 已验证；发布脚本另有 17 项本机临时 SQLite/模拟服务检查。未实际执行本次程序降级或整库恢复；真实业务目标的回退与恢复失败是另一层证据，不能混称                                                                                                                                                                                                                                                                                                                                                                                      |

本轮客户电脑是已授权的 macOS 开发机，使用专用临时工作目录和已配对设备；配对登记继续保留，后续可按既有连接方式续接，不扩大到其他个人目录。真实执行、技能、目录与身份隔离、空闲重启、活动退出保护、未知结果人工核实及断线事件补报的证据见下方收尾实证；没有为得到终态修改私有存储或换请求标识重复执行。

## 历史批次：技能标签修复（2026-10-23，b6f25a04）

真实目录换版时，业务授权快照已经更新，原生技能目录尚未就绪，`ChatComposer` 用两份目录交集生成展示标签，导致草稿标签暂时退回 `$技能名` 文本。现由 `skillContextDisplaySkills` 将公开授权上下文转换为展示项，沿用固定快照的说明地址；候选选择仍按当前授权与原生目录筛选。没有授权上下文时返回空列表，不借展示信息放宽读取权限。

| 证据层次         | 实际结果                                                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向回归         | macOS 技能查询、标签浏览器回归与映射单元测试 20/20；新增换版后的标签、光标、序列化、固定说明地址和无上下文断言；Web 类型、网页构建、176 文件边界与脚本语法检查通过                                                                                                         |
| Linux CI         | [运行链路 39949032576](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39949032576) 与 [独立后端 39949032587](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39949032587) 均通过；上游完整 T3 测试与 Windows 实机不在本轮执行范围 |
| 当批发行         | 完整目录 `/home/tao/autoops-agent-demo/releases/t3-step2-b6f25a04`；5333 文件、61 相对链接，官方同版原生依赖 2038 文件/21 包校验通过；网页 HTML 与 `application-release.json` 应用提交分别核验。健康中的 sourceCommit 表示锁定上游，不能充当应用提交                       |
| 切换与保留       | 空闲时备份并切换网关/Worker，沿用原数据；切换瞬间已有 54 消息、17 运行、172 轮次条目、8 绑定、1 成果、185 工作区/技能文件及 8 部署任务均保留，其他四项服务 PID 不变                                                                                                        |
| 线上专项交互     | `chips-ui-complete/report.json` 3/3：原生选择、真实 HTTP 失败后保留标签与光标，目录换版及刷新后读取当前说明，真实模型发送后的历史标签、剪贴板原文复制和固定工作区文件预览。焦点刷新由浏览器事件触发，不等同于操作系统窗口切换；页面无未处理错误，临时技能和会话已清理      |
| 最终原始数据审计 | 交接前历史行及 159 个原文件均存在；157 个文件摘要未变，两个索引中的原条目逐项保留，仅允许新增验收记录；原部署任务、发布记录、配置、源码包字节与来源引用保留，去重包仅新增本轮来源                                                                                          |
| 健康及程序恢复   | 该批网页入口、Worker 健康、客户 ZIP 摘要与匿名拒绝复核通过；`backups/t3-step2-b6f25a04-20261023/rollback-program.sh --check` 通过，可回到 578a51f3 程序并继续使用当前数据；未执行程序降级                                                                                  |

本补丁未改变后端业务逻辑，继承下方完整基线的真实发布/回退与数据验收。该批无凭据证据为 `.deployment/step2-578a51f3-evidence/result-b6f25a04.json`、`api-smoke-b6f25a04.json`、`final-original-retention.json`；专项截图与操作报告在 `.deployment/step2-build-578a51f3/.test-artifacts/step2-578a51f3/chips-ui-complete/`。该独立构建快照已同步补丁源文件，目录名仍保留初始基线。

文件专项最初误用管理内容接口作为标签地址，已改用公开 `autoops/<project>/workspaces/<version>/...` 合同；Chromium 调试接口的文本解码差异另通过浏览器实际 fetch 和中文呈现核对。保留这些失败报告，不将测试输入与工具解码问题记作产品缺陷。

## 本轮部署与真实验收（2026-10-23，578a51f3）

部署前核实实际旧版为 `t3-modular-81a5c2f8`，分支无新增远端提交，原平台、工作区、部署与客户命令均空闲。新发行目录为 `/home/tao/autoops-agent-demo/releases/t3-step2-578a51f3`，数据继续使用 `/home/tao/autoops-deployment-validation/data`。网关、Worker 与客户下载包同时切换，未启用独立新后端或初始化空库。

| 证据层次       | 本轮实际结果                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提交对应 CI    | [运行链路 39939989273](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39939989273) 与 [独立后端 39939989241](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39939989241) 均通过；Markdown 是定向门禁，原四项失败已修复，不代表全部 T3 上游测试 |
| macOS 构建     | 固定提交独立快照、冻结锁文件；Node 24.19.0 / pnpm 11.25.0，网页、实际 T3 Worker 与客户 ZIP 构建通过；18 项发行测试及发行工作区真实打包 Worker 冒烟通过                                                                                                                                   |
| Linux 发行校验 | Node 24.22.0；5170 文件、61 相对链接及官方同版原生依赖 2038 文件/21 包校验通过，实际 CLI 与工作区 Worker 启动通过；串行独立 cgroup，MemoryMax=512M、MemorySwapMax=0、CPUQuota=100%                                                                                                       |
| 数据保留       | 切换前一致性备份全部非空 SQLite 与业务文件；原 35 消息、12 运行、117 轮次条目、627 编排事件、47 命令收据、35 outbox 记录、4 绑定、1 成果与 159 工作区/技能文件保留；原 4 部署任务及配置历史保留                                                                                          |
| 健康与分发     | 实际生效目录、网页 HTML 与健康核对；客户 ZIP 1042160 字节，SHA-256 `48fb35c3e39fec059671b1825619e09a3b7a3114b9e91c75b2c34534c98481bb`；匿名设备和下载请求均 401                                                                                                                          |
| 生命周期       | 新版空闲时真实停止与重启，历史/文件保留，其他四项服务 PID 不变；发现 Effect 正常中断退出 130 被 systemd 误记为失败，已在本轮 Worker drop-in 增加 `SuccessExitStatus=130` 并复测成功；未吞掉其他错误码                                                                                    |
| 公共框架 UI    | `t3-module-shell-ui.mjs` 10/10；问答、工作区、部署、技能、设备、设置连续切换，侧栏折叠与刷新、浅深色、1440px、390px 与 600px 短窗口、确认 Esc 与焦点。只读业务检查与截图分别保存                                                                                                         |
| 部署 UI        | 对齐现行独立路由、公共侧栏、原生移动抽屉和配置分类后，`t3-deployments-ui.mjs` 只读完整复测 8/8；真实日志滚动、环境隔离、ZIP/清单下载、浅深色及外部账号拒绝通过；另一次浏览器真实提交成功且刷新恢复原任务                                                                                 |
| 技能真实执行   | 本轮临时技能的导入、分配、原生发现和跨身份拒绝通过；真实模型三轮读取参考校验词，旧会话保留旧版本、新会话读取新版；停用后旧预览/后续调用拒绝，两个测试私有会话与临时技能已清理                                                                                                            |
| 工作区真实执行 | 本轮示例外部版本 `648186d3-f651-4800-93f3-385f6b51e22c` 由固定内部版生成；漏复核请求拒绝，明确排除示例图片后发布；外部账号仅见脱敏内容且不能读内部版或提交生成，原内部版摘要不变；真实模型分别完成内外部资料读取并固定会话范围，测试会话已清理                                           |
| 部署真实写入   | 仅使用内置示例 `p-autoops/env-test` 与既有“前端部署验证”目标；新固定源码包、真实 Docker 构建、站点发布、同请求并发去重、手动回退、单任务健康检查 HTTP 503 后自动恢复通过。故障规则已清除，专用 Agent 与站点健康                                                                          |

首批程序恢复点为 `/home/tao/autoops-agent-demo/backups/t3-step2-578a51f3-20261023`。该批切换时其中 `rollback-program.sh --check` 已实际通过；真正的程序降级未执行。回滚脚本先核对空闲及本轮 drop-in 摘要，只恢复程序配置，继续使用当前数据，不用旧库覆盖发布后的新记录。实际部署目标的手动回退与健康失败恢复另有真实任务证据，不能与程序回滚预检混称。

本轮固定包 `dcdb96d7-c076-49a1-87cf-338738cf11ca`，前端 ZIP SHA-256 `10552987e3061076dc073bc771c99b7e48438a3e8f133d639a5afedf9324df02`。新任务分别为浏览器发布 `8b11832a-1864-4489-bcf9-6e1ab67c2dd4`、幂等第二次发布 `93cdbf34-a1d6-4054-bf66-099a8b1e6242`、手动回退 `68fcbb99-a11f-46ee-8f26-c5ab0d28b785`、失败恢复 `b28cec63-4da1-4f05-b5f6-c1165fdfa818`。最后一项准确返回 `rolled_back` / `rollback.status=succeeded`，当前逻辑版本、站点标记和 HTML 摘要与故障前一致。过期配置返回 409，外部账号 GET/POST 返回 403，跨项目目标 GET/POST 返回 404；拒绝请求没有产生任务。

无凭据摘要位于本 worktree `.deployment/step2-578a51f3-evidence/`；截图和原始浏览器报告位于独立源码快照 `.deployment/step2-build-578a51f3/.test-artifacts/`。服务器另保留 `result.json`、`new-release-restart.json`、`additional-history-retention.json` 及本轮独立命名的部署状态/报告。静态截图只证明呈现，任务、下载摘要、真实工具和操作报告分别证明业务执行。

本次首次归档带有 macOS AppleDouble 附属文件，被完整清单检查拒绝；仅移除新发行内未登记且具有 AppleDouble 文件头的 `._*` 后重新校验通过，未在校验失败时切换。后续 macOS 归档应禁用这些元数据。旧 UI 验收脚本的定位失败也保留原始记录；只修正当前页面定位和导航，不放宽权限、焦点、任务、下载或几何断言。

### 第二步收尾实证（2026-10-23）

用户已授权将当前 macOS 开发机作为真实客户电脑接入 Linux 验证中心。客户连接程序使用已发布 ZIP、本机已登录的 Codex CLI 和独立临时工作目录；不上传个人目录或将平台凭据交给客户执行器。以下为本轮分批完成的真实实证；最终发行结论与环境边界见本页最终验收章节。专用设备保持配对登记。

| 范围             | 已核实的结果与证据                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 客户真实执行     | macOS → LAN → Linux 中心，实际发现本机模型与专用技能，完成两轮真实文件写入；客户目录与会话绑定固定，外部账号不能读取私有绑定。证据：`.deployment/step2-closeout/customer/setup-report.json`、`baseline-report.json`                                                                                                                  |
| 客户退出与核实   | 空闲退出后新进程恢复同一原生会话并写文件；活动时第一次退出被保护，第二次强制退出保留 unknown 与目录锁。确认本次受管子进程全部结束后，用公开 resolve 命令核实原 run/attempt，中心得到 cancelled、释放占用，未新增轮次、未执行延迟写入。证据：`resume-report.json`、`verify-forced-exit-report.json`                                   |
| 客户断言修正     | 首次脚本误期望人工核实结果为 failed/interrupted；实际公开恢复合同映射为 cancelled。保留原失败记录，修正断言后只读核对原任务，未重复执行故障轮次；不将测试断言错误列为产品缺陷                                                                                                                                                        |
| 身份与迟到响应   | 真实切项目、管理员退出再登录外部账号，放行先前截留的真实 HTTP 200 响应均不能恢复旧范围内容；外部账号实际请求内部资源返回 403。证据：`.deployment/step2-closeout/ui/isolation/report.json`                                                                                                                                            |
| 流式阅读         | 真实模型输出期间上读到 top=0，连续 78 次采样保持位置，内容高度从 1917 增长至 3146；专用会话已清理。证据：`ui/stream-trace/report.json`                                                                                                                                                                                               |
| 成果报告         | 私有会话实际生成 Markdown 与 PDF，所有者下载并回读中文及唯一标记；其他管理员与外部账号 404、匿名 401，删除本轮会话后原下载链接 404。证据：`workspace/report-acceptance.json`                                                                                                                                                         |
| 导入失败与取消   | 非法来源拒绝且不建任务；无效分支失败保留原收据，改参数 409；61e9ed11 合法导入固定提交成功，实际 running/fetching 阶段取消保留 interrupted/cancelled，重复取消/原请求不重启且不产生半成品。失败后显式新请求恢复成功、旧版本保留。证据：`workspace/import-report.json`、`import-fixed-report.json`、`import-active-cancel-report.json` |
| 本地真实信号排空 | 独立配置业务宿主收到实际 SIGTERM 时仍有 2 项 packaging、4 项 queued；停止接单后 122ms 排空 6 项任务并生成 12 份 ZIP，资源关闭、自然退出。新进程读取同任务及一致摘要、同请求不新增任务。证据：`workspace/lifecycle/report.json`；该证据来自 macOS 隔离宿主，不称为线上完整 T3 宿主的活动任务信号实测                                  |

客户活动断线新增实证：仅停止专用网关，Worker 与本机执行器保持运行；本机在中心不可达期间完成文件写入，事件 `tail=68 / ack=46` 持久保留，重连后 `ack=68`，同一轮次完成且未重新提交。报告为 `customer/disconnect-network-report.json`。首次保护脚本误将不含 threadId 的原生 attempt/turn 识别为外部活动而拒绝停机；已按真实引用关系修正并保留首次报告，不将未形成断线的那轮计为通过。

线上恢复演练：任务 `2186adb5-ee18-455b-b7fc-de42444c8caa` 在中心停止期间成功，原 Agent 记录 `seq=30 / ackSeq=24`；重启后确认到 30，日志连续，原请求仍对应原任务。首次 180 秒监控预算不足是 Docker 新镜像层仍在下载，业务任务没有失败；随后仅续验原任务。真实恢复失败任务 `995a842d-9015-4aba-befc-e95b369ee511` 返回 `failed / rollback.failed`，清除候选与基线的精确健康故障后，显式恢复任务 `0683d5ba-8447-4c92-8da4-9d3050b6c023` 成功，原失败历史保留。证据为 `recovery/report.json`；故障规则已清空，站点正常、四项无关服务 PID 不变。验收 harness 各自处于 512MiB/no-swap cgroup，实际构建容器采用 1024MiB 上限；Docker daemon 本身不受 harness 总限额约束，不能混称。

真实系统焦点与停用组合也已通过：独立 Chrome 窗口之间产生可信 blur/focus 与实际焦点变化，技能标签及光标保持；技能停用后原固定说明返回 403，加载新授权目录后才释放暂存的旧 200 响应，旧候选与标签均未恢复。证据为 `ui/focus-revoke-real/report.json`；本轮临时技能、浏览器与 profile 已清理。

验收新增发现两项实现缺陷：Git 导入的周期容量扫描不容忍克隆期间临时文件消失；代码文件的 Pierre Virtualizer 未纳入工作区滚动视口采集，切页面后阅读位置回到顶部。前者通过真实文件消失的确定性回归复现，修复仅容忍子项 ENOENT，仍拒绝根目录消失、权限/I/O 错误、超限和符号链接；发布固定快照继续严格扫描。线上首次失败未记录具体 errno，不能将竞争复现冒充该次线上错误日志。后者以真实固定文件、滚轮及切页复现 top=800 → 0，修复复用原生文件模块的公共视口入口并等待异步尺寸；后续又定位到冷刷新时环境尚未就绪、文件视口未挂载而恢复监听未重新安装的问题，最小修复将环境标识纳入 effect 依赖；最终定向回归及线上复验见本页最终验收。

### 历史批次：导入与阅读修复（2026-10-23，61e9ed11）

当批完整发行 `61e9ed11cd4cc5f97a2cbc368a78b74c0f53bedd` 已部署，运行链路 [39958840075](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39958840075) 与独立后端 [39958839943](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39958839943) 均通过。Linux 运行链路为 Node 415、Server 106（另 2 跳过）、Web 167、客户 17；Markdown 定向三组 179/41/20，另 88 项非本门禁目标跳过。发行清单 5495 文件、61 相对链接和官方原生依赖校验通过，实际 CLI 与隔离打包 Worker 启动通过。

切换脚本运行 12.215 秒，沿用原数据并保留 206 个工作区/技能文件、客户设备与目录绑定、1 个传输会话、12 个命令及 3 个游标；其他四项服务 PID 不变。程序回滚预检通过，未实际执行程序降级。随后对首批发布前原始数据复核通过：159 个原文件仍在，157 个摘要未变，两个索引原条目保留；原历史、部署配置与源码包也保留。证据为 `release/switch-final.log`、`rollback-ready-61e9ed11.json`、`retention-61e9ed11.log`。

合法导入已在该版真实完成，固定 Git 提交 `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`、读取与下载一致、原请求去重、失败后显式新请求恢复均通过。另在观察到 running/fetching 后取消，保留 interrupted/cancelled 收据、不产生半成品版本；旧失败任务保持原结果。证据为 `workspace/import-fixed-report.json`、`import-active-cancel-report.json`。

浏览器未知提交结果也已实测：真实回退请求被服务接受后丢失响应，界面明确显示待核对，刷新保留原请求；再核对返回原任务且不新增任务。随后仅重放同一请求补齐错误提示出现时序断言。证据为 `ui/deployment-unknown/report.json`、`deployment-unknown-reconcile/report.json`。静态截图发现核对按钮被 T3 Alert 误当作图标槽，现将文本与按钮放入公开 AlertDescription；权限和原请求语义保持不变。

跨页面阅读已在线恢复到 top=800；冷刷新仍归零的原因另由实际时序证明：环境未就绪时文件区未挂载，之后环境到达却未重新安装恢复监听。现将环境标识加入该 effect 依赖，并补充 null 到就绪的回归；该问题当时尚待后续补丁，最终修复和线上复验已在本页最终验收中单独记录。追踪脚本早期 observer 注入错误属于测试诊断问题，原始复现无页面错误，原失败记录继续保留。

### 第二步完成结论与未测边界

当前已实现功能基线内，本轮模块优化与验收发现的问题已闭环，第二步完成。验收同时使用本地定向检查、Linux CI、真实发行校验、线上只读浏览和隔离项目的真实写流程；每层结果分别记录，不以入口存在、截图或 health 代替业务成功。

- 已验证运行环境是 Linux 实际服务、macOS Chromium 和真实 macOS 客户电脑；390px 触屏视口与短窗口属于浏览器验证。Windows 实机、实体手机输入法/软键盘、普通公网 HTTPS/WSS、整套 T3 上游测试未执行，不计为本轮通过。
- 活动排空实证来自 macOS 隔离配置宿主的真实 SIGTERM；线上完整 T3 宿主完成空闲切换及远端已领取任务跨中心重启，不将两者混称线上本地任务活动排空实测。
- 程序降级和整库恢复未在线执行；当前具有一致性备份、保留当前数据的可执行回滚方案及预检。已实测的业务发布回退、恢复失败和显式恢复成功不替代程序降级证明。
- 当前继续采用单实例写入、既有部署持久格式及现行平台身份。多实例、新身份后端接管、尚未实现的业务功能与公网接入按后续明确需求推进，不为本轮补建。
- 首次 Docker 拉取超过 180 秒监控预算、定位或诊断脚本错误以及最初 UI 失败均保留原报告；已经修复复验的问题不继续列作遗留缺陷，未覆盖的环境不伪称通过。

## 上一轮已部署验收记录（2026-10-23，81a5c2f8）

模块改造及部署撤权补丁已以 `a212086a57dcec562c23ee3fbfbbb799068a053f` 完成完整回归并发布；最终预览提交 `81a5c2f861e9af04a4fa89577f24c311ae814388` 修复线上验收发现的部署确认取消后焦点恢复问题，也已通过下表完整回归并部署。程序使用不可变发行目录，业务数据继续使用原数据目录。

| 检查                                       | 实际结果                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 运行边界、格式、根/Web/Server/客户程序类型 | 通过；165 个运行源文件，0 个边界错误                                                                                                   |
| Linux Node 运行链路                        | 383/383 通过，包含真实 Chromium 富结果及模型权限夹具                                                                                   |
| Linux T3 Server                            | 104 通过；2 个原有真实 Codex CLI 元数据探测因未提供 `AUTOOPS_TEST_CODEX_BINARY` 条件跳过                                               |
| T3 Web                                     | 23 个文件、120/120 通过，包含撤权、迟到响应、设备隔离与窄屏交互                                                                        |
| 客户程序及真实 ZIP                         | 17/17 通过；既在独立 CI，也在服务器隔离目录验证                                                                                        |
| 独立 AutoOps 后端                          | 21/21 通过；只证明该独立切片，不代表已接入线上                                                                                         |
| 发行验证                                   | 本机构建网页、Worker 与客户 ZIP；目标 Linux 目录校验完整清单、原生依赖、工作区真实打包 Worker 与 CLI 启动入口                          |
| 切换与保留                                 | 空闲检查后备份六个 SQLite 库和业务文件；健康、静态资源、原工作区/技能文件、原会话历史及部署配置/历史均核验；其他服务与已有站点保持不变 |

线上只读交互覆盖问答、工作区、部署、技能、设备、设置、侧栏折叠与刷新、短窗口和 390px 手机抽屉、部署配置/确认取消、源码包清单及焦点恢复。最终版本的两次验收与针对性补跑合并后，11 项均有实际通过证据；没有业务 HTTP 写入、模型调用或真实发布，任务、源码包和运行版本前后相同。原工作区与技能共 159 个文件及会话、部署历史均保留。

本次访问链路存在无缓存静态资源加载偏慢：曾因部署路由脚本等待 30 秒超时；保留原始失败记录，只在路由资源加载完成后补验交互。补跑该脚本下载耗时 7192ms，取消焦点断言预算仍为 5 秒。此项不作为性能达标结论，后续排查网络与静态资源传输；不以放宽交互断言掩盖问题。

自动验收证据：[工作台运行链路](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39923043878)、[独立后端](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39923043841)。服务器保留本次 before/result、SQLite 一致性副本和程序回滚脚本；程序回滚不会覆盖新产生的业务数据。

验收期间，共享主机安装依赖曾导致旧 worker 因内存压力自动重启；已核对恢复后的健康及任务完成状态。随后验收进程采用独立 512 MiB cgroup，完整回归移至独立 CI；服务器限额内未完成的整套测试没有计作通过。此限制已纳入上面的运维要求。

### 技能候选等待恢复（2026-10-24）

上一批在新对话路径修复两处等待缺口：缺失目录时原重试计时器只处理 `slashCommandsPending`，普通失败无法自动续试；已返回空目录也被文案误判为仍在加载。原生目录刷新从 `ChatComposer` 收拢为 `useProviderWorkspaceSnapshotRefresh`，继续调用 `serverEnvironment.refreshProviders`，负责读取等待、重试和清理，不拥有技能数据。技能库、原生模型目录及授权交集的所有权不变，客户本机目录仍保持隔离。

复用 `ComposerCommandMenu` 错误行及键盘重试。目录暂缺自动续试，30 秒总等待结束后失败；空目录停止等待且允许重新扫描。授权目录支持手动重试与网络恢复刷新；切范围和卸载清理定时器并忽略旧请求完成，旧标签与光标维持已有复核规则。macOS Web 类型检查、26 项定向浏览器回归、199 文件模块边界检查、完整网页和 Worker 构建通过。完整问答页面本机故障注入 3 项通过：挂起读取超时、浅深色 × 1440/390×560 错误行、键盘重试保留输入与焦点及 Esc 关闭；没有业务写入或模型调用。截图和操作记录位于 `.deployment/skill-picker/ui/`。线上抽查原版本技能候选可以正常出现，间歇故障未当场复现。应用 `40b66307` 两项 CI 通过并完整部署，发行清单、实际网页与目录、健康状态及既有数据保留通过；线上真实技能候选、选择标签、固定说明预览和清空验收输入通过，没有发送消息或调用模型。程序回滚预检通过，未执行真实降级。未修改服务端权限或执行协议。

### 新旧对话使用当前技能（2026-10-24）

旧会话曾固定首次技能清单，部分分配撤回后会阻断整份目录；此前的明确拒绝提示仍不符合用户期望。本批按最新产品决定改为新旧对话读取当前项目、助手和工作区的有效分配，未分配或停用项不显示，不影响其余技能及普通问答。历史包和可见会话归属收据保留，历史读取仍校验当前权限；不再要求新建对话。现行业务规则维护在[精简版能力边界](../examples/agent-demo-lite-profile.md)。

复用原生技能目录、`ComposerCommandMenu`、技能输入和会话恢复协议。技能目录变化时，下一轮解除空闲原生会话订阅并以当前目录、说明及权限恢复同一会话，确认实际目录一致才发送；不修改会话历史或另建轮次状态。发送边界再次检查所选技能，拒绝已撤回项和不属于当前目录的路径。重试同时刷新当前业务分配和原生目录，不重复读取已失效的旧清单。客户本机目录保持独立。

macOS 46 项定向 Node 回归、18 项浏览器回归和 3 项执行协议回归通过，覆盖部分/全部停用、普通续聊、版本更新、历史私有归属、迟到响应、原生热会话配置重载及重载未生效时不发送；协议回放不等同真实模型调用。完整运行检查、网页/Worker/客户包构建和应用 `33e30846` 两项 CI 通过并已完整部署。Linux 真实原生协议在隔离范围完成技能升级、全部停用、同一会话恢复和合成历史保留；线上旧/新对话当前候选、标签、说明预览和失效目录重试通过。用户未发送输入及既有业务数据保留；29 项恢复脚本回归及程序回滚预检通过，未实际降级。证据在 `.deployment/current-skills/`；本批没有真实模型请求或客户本机写操作。

### 客户电脑图片与文件输入（2026-10-24）

客户会话复用锁定 T3 的 `ChatComposer`、附件上传、文件标签、图片预览、发送及 Codex 原生图像输入。文件选择、拖入文件与粘贴截图汇入同一附件入口；用户发送后，连接程序自动下载到私有缓存并交给本机 Agent，不写入客户项目。平台资料、终端上下文、其他人的附件及生成文件回传仍保持既有隔离，不因开放输入附件而放开。

| 所有权与公开协作                                                                                | 验收与失败影响                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 拥有附件字节；access 拥有用户、私有会话与附件授权；CustomerAttachmentDelivery 只读已授权附件 | 下载按设备、命令、会话及附件逐项匹配，读取后复核授权；匿名、其他设备、跨会话、撤权、删除会话与内容变化均拒绝                                |
| RemoteDeviceService 拥有可靠命令和摘要清单；客户端缓存拥有落盘、校验、清理与会话内解析          | SHA-256/大小校验、45 秒传输期限、串行下载、1 GiB 缓存上限；中断或损坏不会启动本机轮次，重复命令核对原收据；旧客户端不宣告能力时在派发前拒绝 |
| HeadlessCodexRunner 通过附件路径解析端口复用 CodexExecutionHost；不依赖平台存储                 | 文件作为本机路径、图片作为原生图像输入；缓存位于连接程序状态目录，非用户项目目录                                                            |
| 网页沿用原生编辑器与预览，没有新增表单或搬运步骤                                                | 修复已接收附件误经客户外部文本过滤的问题；继续输入保持标签。平台引用粘贴仍过滤；权限始终由服务端裁决                                        |

本机自动验证：客户缓存、执行器、真实 WebSocket/HTTP 与模拟 CLI、策略和注册目录 35 项通过；服务端附件 HTTP/ACL 4 项通过；附件定向 Web 测试 25 项，后续标签邻接与上传状态 10 项通过。运行类型检查、网页、实际 Worker、客户 ZIP 构建及真实 ZIP 分发验证通过。模拟 CLI 测试验证字节和原生请求，不代替真实模型。应用 `13c8e391` 的两项 CI 及 Linux 发行清单、原生依赖、隔离 Worker 验证通过；现行摘要与程序恢复入口统一见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。

真实验收经 `https://auto.996788.xyz/`，使用已授权当前 Mac、客户程序 0.2.0、本机 Codex 与 GPT-6-Astra。网页选择文本文件、粘贴 PNG，继续输入后发送，原生读取缓存文件并正确返回 `FILE-927164`、`IMG-438926`、蓝色、3 个；轮次为 completed。未发送个人文件，未改客户项目。预览打开、Esc 关闭及焦点回到预览按钮通过；浅深色桌面、390×700、390×500 下的展示与输入入口已检查，临时草稿、视口和主题恢复。截图证明呈现，实际模型收据和命令证明读取。

尚未单独执行操作系统文件拖拽手势、Windows 真机、实体手机选取/粘贴及大文件极限真机传输；拖拽入口沿用原生同一上传处理，大小、配额、截断、取消与重放由定向自动测试覆盖。未运行全部 T3 上游测试，不将本批功能完成视为这些环境全部验证通过。证据为 `.deployment/customer-attachments/live-projection.json`、`live-result*.png`、测试日志和后续发行目录。

### 客户默认思考档位（2026-10-25）

客户模型目录此前只保留可选档位，丢失原生模型的默认标记，导致用户未手动选择时 `TraitsPicker` 只有图标。连接程序 0.2.1 通过 `CustomerModel.defaultReasoningEffort` 保留原生默认值；注册目录校验该值属于支持选项，网页还原原生 `isDefault`，显式选择仍优先。旧客户端没有报告默认值时显示“默认”，不猜测或替用户设置具体档位。模型、目录、选择及执行仍由原模块拥有，没有新增存储或第二套选择器。

macOS 定向 Node 22 项、Web 8 项、独立 ZIP 分发及真实本地 WebSocket/模拟 CLI 各 1 项通过；后者确认默认 medium 和用户显式 high 分别完整传递到目录及原生 `turn/start`。完整运行检查、网页和客户包构建通过。首次协议测试遗漏测试夹具的目录发布回调，补齐后通过；没有修改生产回调。以上模拟协议不代替真实模型调用。应用 `46ee03b2` 两项 CI 均通过，实际 Worker 重新构建后的最终发行、健康状态及数据保留已核验，现行摘要与恢复步骤见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)。证据位于 `.deployment/customer-reasoning/`。

公网 HTTPS/WSS 实际 Mac 目录确认 GPT-6-Astra 默认 medium；页面显示“中”，菜单中的默认标记与选中状态一致。手动选择“高”后刷新保留，验收后恢复“中”；旧 0.2.0 程序的兼容显示“默认”也已实测。浅深色桌面及 390×500 菜单、全部档位、Esc 与输入焦点通过，原主题和视口恢复；未发送新消息或改客户项目。本次没有重跑实体手机、Windows 或整站全部布局。第一份发行的旧 Worker 编译包拒绝新字段，已在独立 `-r2` 发行重建并确认目录成功刷新；不把第一次切换计为功能验收完成。

### 客户电脑文件引用（2026-10-25）

客户连接程序的 `files.ts` 拥有已登记目录的只读浏览、搜索、受限预览和执行前引用解析；中心 `RemoteDeviceHub.readFiles` 只管理有界临时请求，`customerFilesHttp` 使用当前登录者、项目、环境和固定执行目标复核授权。读取不会创建 Codex 运行器、占用执行队列或写入可靠执行日志；断线、取消、超时与 Agent 任务状态分开。公开合同为 `customerFiles.ts` 和既有设备帧，客户目录及凭据仍不进入平台业务存储。

页面复用 T3 `FileBrowserPanel`、`ReadOnlyFileSource`、原生文件标签、Menu/Dialog 和 `ReadOnlySourcePreview`；附件菜单增加“引用电脑文件”，`@` 搜索使用同一范围。目录串行按需展开，不开放整树展开；每次目录最多 120 项、搜索最多 40 项、预览最多 16 KiB。引用保存登记身份与相对路径，执行时由客户电脑核对当前文件；删除、撤销、目录替换或跨设备引用明确失败，历史预览不冒充文件快照。

本机检查、网页/实际 Worker/客户包构建通过。定向客户 Node 与真实 ZIP/传输 39 项、服务端 HTTP/权限/生命周期及适配器 42 项、共享文件浏览/资料预览 15 项通过。选择与 Markdown 引用浏览器回归 24 项通过（该定向命令另有 88 项未运行），焦点恢复另跑选择器 4 项通过，与前项有重叠，不相加计数。模拟 4G 使用真实本地 WebSocket、300ms RTT、客户上行 256kbps、下行 1Mbps：目录 315ms、搜索 314ms、16KiB 预览 840ms，返回体分别 148、153、17044 字节；该结果不包含模型推理、网页首次下载或证明全部真实移动网络。取消和迟到响应、撤权、越界和符号链接、二进制与截断、目录替换、引用去重分别有定向测试。

公网实际 Mac 已使用 0.3.0 连接程序。专用私有会话 `d6e0483b-7462-43c9-88f1-51c780aae318` 的三轮 Codex / GPT-6-Astra 均完成：附件菜单选择与发送、`@` 搜索后读取刚更新的文件、连接程序重启后恢复同一原生会话并再次读取。原生会话始终为 `01a170e8-420e-7f80-a923-780e4aafb6ed`，三条 `cat 'autoops-file-acceptance-26308cda/src/client (4G).ts'` 的退出码均为 0，返回初值 `LOCAL-4G-26308CDA` / `7624`，更新后返回 `LOCAL-4G-UPDATED-26308CDA` / `7625`。原消息只保存登记身份与相对引用，上传附件数为 0；只修改自动生成的隔离夹具，未扫描或修改客户个人文件。

实际网页已核验浅深色桌面、390×500 短窗口、历史标签再次预览、长路径截断、16KiB 长文件提示、内部滚动及固定底部操作。布局复用完整 T3 文件树与源码预览；窄屏在列表与预览间切换，不另建卡片式界面。首次键盘检查发现 Esc 后焦点落在页面，已补上原生 Dialog 的关闭焦点回调；`8b5be65e` 部署后真实网页确认关闭选择器回到消息输入框、关闭历史预览回到原文件按钮，两条路径也有浏览器回归。验收后主题与窗口恢复原状。

首份发行的真实操作发现适配器漏传目录绑定、`@` 旧限制及历史普通链接，已由 `f30a52b2` 修正；该提交、主实现 `26308cda` 及最终焦点修复 `8b5be65e` 的两项 CI 均通过。首次未执行空会话在重启后恢复时另遇旧占位线程问题，未重发未知操作；确认本任务进程及其子进程结束后，使用连接程序原生 `resolve` 保存人工核实收据并重连。本机均已空闲，中心仍保留该无 run 身份的未知恢复收据，不能表述为自动收敛；本批发布与程序回滚只按固定摘要的人工证明识别这一条命令，原记录保留，其他未知结果仍拒绝。上述成功会话的重启恢复实测通过，不据此宣称所有失败空会话均可自动恢复。Windows 真机、实体 4G 网络和全部 T3 上游测试未执行。发行与数据保留见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)，证据位于 `.deployment/customer-files/`、`.deployment/customer-files-r2/` 与 `.deployment/customer-files-r3/`。
