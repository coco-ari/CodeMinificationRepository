# 当前运行模块与检查入口

这里记录当前分支的实现及调用边界，不替代[开发规范](README.md)。线上工作台仍由 `agent-demo` 网关、锁定 T3 和业务适配器组成；独立 `autoops/server` 的账号与项目后端另用 `verify:autoops` 验证，尚未替代线上身份或数据。历史目录中仍被调用的能力继续保留。

## 启动与装配

- `pnpm start:agent-demo` 启动[网关](../agent-demo/server.mjs)，T3 模式由 `AGENT_DEMO_ENGINE=t3` 选择；网关负责登录、同源 HTTP/WebSocket 代理与静态资源，不拥有 T3 轮次。
- `pnpm start:agent-demo:t3` 通过[启动器](../scripts/start-t3-worker.mjs)装配锁定 T3 worker，监听回环地址。`DATA_DIR`、`AUTOOPS_T3_BASE_DIR`、`AUTOOPS_T3_PORT` 及外置凭据沿当前部署配置提供；不得用测试默认值覆盖已有服务。
- T3 [HTTP 适配入口](../vendor/t3code/apps/server/src/autoops/http.ts)、[RPC 适配入口](../vendor/t3code/apps/server/src/autoops/rpc.ts)及客户接入入口，从认证请求取得身份后调用业务适配器。T3 原生会话、命令、事件及恢复仍由上游服务拥有。
- 前端由 [hostConfig](../vendor/t3code/apps/web/src/autoops/hostConfig.ts) 组合启动与公开出口；[hostSnapshot](../vendor/t3code/apps/web/src/autoops/hostSnapshot.ts) 只保存已认证宿主快照和用户存储视图，[threadScopes](../vendor/t3code/apps/web/src/autoops/threadScopes.ts) 通过统一客户端处理会话范围。页面继续使用当前 T3 路由与公共框架，组件不读取服务端表或凭证。
- 部署保留 [DeploymentService](../src/deployment.mjs) 与 [Agent](../agent/main.mjs) 的现有协议、构建及恢复；业务适配器只提供项目授权、固定工作区包与公开 DTO。

## 已实现模块

表中的验证路径均为当前测试入口；列出测试不表示本次已执行或全部通过。持久文件属于配置的数据目录，不能在发布时用示例或旧备份覆盖。

| 模块与公开入口                                                                                                                                                                                                                                   | 数据、状态及权限所有者                                                                                                     | 允许依赖与调用边界                                                                                                                       | 主要验证                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 登录与网关：[server.mjs](../agent-demo/server.mjs)、[gateway.mjs](../agent-demo/t3-adapters/gateway.mjs)                                                                                                                                         | 网关登录会话及 CSRF；T3 登录映射由 access 管理；目前业务账号目录仍有既有示例来源，不等同于新账号后端接入                   | 调用 access 与 T3 同源代理；不直接发起第二套对话执行                                                                                     | `t3-host-csp.test.mjs`、`access.test.mjs`、`t3-worker-policy.test.mjs`                                                         |
| 项目、环境及会话授权：[access.mjs](../agent-demo/t3-adapters/access.mjs)、[rpc-policy.mjs](../agent-demo/t3-adapters/rpc-policy.mjs)                                                                                                             | `t3-autoops.sqlite` 中的业务绑定、附件授权和原生会话映射；固定项目、环境、资料版本、私有受众及执行目标                     | 引用工作区版本、模型能力与客户目录公开查询；HTTP/RPC/MCP 统一经过 access；不依赖 T3 HTTP 实现                                            | `access.test.mjs`、`t3-project-memberships.test.mjs`、`t3-workspace-scope.test.mjs`、server `rpc.principal.test.ts`            |
| 工作区：[workspaces.mjs](../agent-demo/t3-adapters/workspaces.mjs)、[workspace-http.mjs](../agent-demo/t3-adapters/workspace-http.mjs)                                                                                                           | `project-workspaces/<项目>/` 下的内部版本、外部脱敏版本、索引、任务和固定源码包；异步任务归服务端                          | 引用既有归档校验与 Git 能力；会话及部署经公开方法引用固定版本；页面退出不取消已提交任务                                                  | `t3-workspaces.test.mjs`、`t3-workspace-scope.test.mjs`、`t3-project-memberships.test.mjs`                                     |
| 技能：[skill-library.mjs](../agent-demo/t3-adapters/skill-library.mjs)、[scoped-skills.mjs](../agent-demo/t3-adapters/scoped-skills.mjs)、[skill-library-http.mjs](../agent-demo/t3-adapters/skill-library-http.mjs)                             | `t3/skill-library-v2/index.json` 与不可变版本目录；SQLite 仅协调该库写锁；技能分配、停用、撤回与会话快照由技能模块管理     | 复用 YAML、ZIP、安全文件读取；平台技能与客户本机技能分开；发现、标签与正文读取使用同一授权版本                                           | `t3-skill-library.test.mjs`、`t3-scoped-skills.test.mjs`、`t3-skills-management.test.mjs`、Web `skillLibrary.test.ts`          |
| 资料、附件及成果：[resources.mjs](../agent-demo/t3-adapters/resources.mjs)、[business-tools.mjs](../agent-demo/t3-adapters/business-tools.mjs)、[business-documents.mjs](../agent-demo/t3-adapters/business-documents.mjs)                       | `t3-business.sqlite` 的报告与成果；附件元数据及范围由 access/T3 各自管理，工作区文件由工作区管理；解析进程只接收已授权字节 | 经 access 校验私有受众，调用工作区、技能及报告公开读取；文档解析复用现有 worker，不向前端暴露宿主路径                                    | `t3-resources.test.mjs`、`t3-business-tools.test.mjs`、`t3-business-documents.test.mjs`、`agent-demo-attachments.test.mjs`     |
| 发布与部署：[deployments.mjs](../agent-demo/t3-adapters/deployments.mjs)、[deployment-http.mjs](../agent-demo/t3-adapters/deployment-http.mjs)                                                                                                   | `deployment-center/state.sqlite` 的项目映射、目标、固定包来源和部署任务；运行版本、阶段、日志与恢复由原执行引擎拥有        | 调用 access、工作区公开包读取及 `src/deployment.mjs`；不让模型或 UI 直接控制 Agent；后台领取同样核验权限                                 | `t3-deployments.test.mjs`、`deployment-workspace-source.test.mjs`、`deployment-lifecycle.test.mjs`、`deployment.test.mjs`      |
| 部署执行器：[agent/main.mjs](../agent/main.mjs)、[runner.mjs](../agent/runner.mjs)、[static-deployment.mjs](../agent/static-deployment.mjs)                                                                                                      | Agent 本地身份、执行收据、源码与构建缓存、静态版本目录；保持目标串行及未知结果核查                                         | 只通过既有中心协议领取、汇报及下载；不反向导入工作台、页面或业务授权存储                                                                 | `agent.test.mjs`、`source-cache.test.mjs`、`build-cache.test.mjs`、`static-build.test.mjs`、`integration-protocol.test.mjs`    |
| 我的电脑：[customer-registry.mjs](../agent-demo/t3-adapters/customer-registry.mjs)、[customer-transport.mjs](../agent-demo/t3-adapters/customer-transport.mjs)、[客户程序](../agent-demo/customer-agent/README.md)                               | 平台记录设备所有权、配对、登记目录、连接代次与可靠收据；客户本机 store 保存本地身份和执行记录                              | 复用 T3 `autoopsRemote` 协议与 HeadlessCodexRunner；客户端禁止打包平台数据库、凭证及业务适配器；平台普通管理员不能取得其他用户设备执行权 | adapters `customer-*.test.mjs`、customer-agent `*.test.ts`、server `Remote*.test.ts`、`customerHttp.test.ts`                   |
| 模型与原生运行策略：[models.mjs](../agent-demo/t3-adapters/models.mjs)、[launcher.mjs](../agent-demo/t3-adapters/launcher.mjs)、[codex-policy.mjs](../agent-demo/t3-adapters/codex-policy.mjs)                                                   | 经过验证的模型目录及宿主启动配置；轮次模型与思考强度沿用户提交值，执行由 T3 拥有                                           | 使用外置凭据引用、技能快照和既有原生权限配置；不恢复旧 bridge 或另建轮次状态机                                                           | `t3-models.test.mjs`、`t3-native-catalog.test.mjs`、`t3-worker-policy.test.mjs`、`t3-product-profile.test.mjs`                 |
| 个人偏好与导航：[preferences.mjs](../agent-demo/t3-adapters/preferences.mjs)、[settings-preferences.mjs](../agent-demo/t3-adapters/settings-preferences.mjs)、[projectNavigation.ts](../vendor/t3code/apps/web/src/autoops/projectNavigation.ts) | 私有阅读水位、置顶/稍后处理等偏好及用户项目选择；不改变共享执行状态或会话绑定                                              | 引用原生时间及 shell 投影；切项目仅改变导航，不能重绑已接受的会话或业务任务                                                              | `t3-preferences.test.mjs`、`t3-settings-preferences.test.mjs`、`t3-project-navigation.test.mjs`、`t3-settings-return.test.mjs` |
| 前端业务组合：[autoops 目录](../vendor/t3code/apps/web/src/autoops)、[部署展示公开入口](../vendor/t3code/apps/web/src/autoops/deployment/index.ts)                                                                                               | 页面请求、表单草稿及展示状态；服务端事实只通过客户端合同读取；错误边界保护公共壳                                           | 复用 T3 组件及当前路由；部署子模块只经 `deployment/index.ts` 被外部引用，内部不反调页面；请求共享边界不得依赖业务界面                    | Web `src/autoops/**/*.test.ts(x)`、`runtime-boundaries.test.mjs`、只读 `t3-module-shell-ui.mjs`                                |
| 独立新后端：[autoops 模块入口](../autoops/README.md)                                                                                                                                                                                             | 独立账号、项目、环境、统一授权、审计与升级；运行库与当前线上数据分开                                                       | 只经 `autoops/contracts` 共享纯合同；不导入旧宿主形成双写或隐式身份回退                                                                  | `pnpm verify:autoops`                                                                                                          |

现有资源查询和工具连接只按已完成能力展示；上述“资料与成果”不是已实现 Server/MySQL/Redis 自助管理。机柜原型、通用通知、尚未实现的后台功能仍按当前入口与计划区分，不能因模块表出现名称而创建占位菜单。

## 本次收敛的内部边界

- HTTP 仅由 [http.ts](../vendor/t3code/apps/server/src/autoops/http.ts) 装配，按工作区、部署、技能、会话和资料划分 [http/](../vendor/t3code/apps/server/src/autoops/http) 路由。共享身份、业务实例和错误映射属于 context/responses；子模块不能反向调用 HTTP、RPC 或客户接入入口。
- 工作区的公开业务入口仍为 workspaces.mjs；[workspace-jobs.mjs](../agent-demo/t3-adapters/workspace-jobs.mjs) 管理任务生命周期，[workspace-files.mjs](../agent-demo/t3-adapters/workspace-files.mjs) 管理受限文件操作，[workspace-packages.mjs](../agent-demo/t3-adapters/workspace-packages.mjs) 调用受限 Worker 打包。发行时须一起携带 workspace-package-worker.mjs；不能只发布原入口而漏掉后台实现。
- 授权的唯一公开入口为 [access.mjs](../agent-demo/t3-adapters/access.mjs)。内部 access-identity 管理登录与会话映射，access-bootstrap 管理宿主投影，access-service 管理现有业务策略，access-runtime 装配配置与 SQLite；项目成员和环境授权内部复用 [project-access.mjs](../agent-demo/t3-adapters/project-access.mjs)。其他模块不得直接引用这些内部实现。工作区与部署服务只在完成授权后操作自身数据；后台任务接受和执行阶段仍校验调用者范围，退出页面不改变任务所属身份。
- 部署中心经 [DeploymentService](../src/deployment.mjs) 的公开用例提供项目同步、目标创建和领取归属查询；[deployment-projects.mjs](../src/deployment-projects.mjs) 是引擎内部实现，业务适配器不直接引用它或读取存储。源码构建由 [RepositoryService](../src/service.mjs) 拥有：部署通过 captureArchive、pinRevision、releasePin、cachedCommitSubject 和 waitForIdle 协作，不改写注入的 builder 方法。captureArchive 在源码锁内完成归档消费，同次构建的单个固定失败不破坏普通下载；消费函数不得重入相同源码的构建、历史或固定接口。
- T3 原生附件通过宿主 [resourceCatalog.ts](../vendor/t3code/apps/server/src/autoops/resourceCatalog.ts) 注入公开读取端口；resources.mjs 只负责业务授权与资料投影，不反向导入 attachmentStore，也不查询其他模块的表。
- 工作区、部署和客户执行等已共享 DTO 归 [autoops/contracts](../autoops/contracts)；[apiClient.ts](../vendor/t3code/apps/web/src/autoops/apiClient.ts) 统一请求和错误，工作区轮询与页面错误由所属 hook/ModuleErrorBoundary 管理。它们不改变 T3 会话执行与恢复来源。

- 工作区页面只组合路由、任务和表单；[WorkspaceFileBrowser](../vendor/t3code/apps/web/src/autoops/WorkspaceFileBrowser.tsx) 适配原生文件浏览与固定版本读取，workspaceViewState 仅供工作区内部共享阅读偏好。技能页面保留选择、对话框与导航，[useSkillLibraryCatalog](../vendor/t3code/apps/web/src/autoops/useSkillLibraryCatalog.ts) 负责目录读取、变更与撤权；旧页面写入结果不能覆盖新页面状态。
- [BusinessRuntime](../vendor/t3code/apps/server/src/autoops/BusinessRuntime.ts) 在现有 Effect 宿主中装配业务生命周期，[business-runtime.mjs](../agent-demo/t3-adapters/business-runtime.mjs) 只协调各模块公开停止/关闭端口。初始化失败同样释放已取得资源；已停止的配置实例不会被惰性读取重新创建。具体排空策略及验收见下表与关闭测试。

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
| `pnpm test:runtime:web`         | T3 Web `src/autoops` 的单元与浏览器组件测试；不是所有上游 UI 测试                                    |
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

| 模块                 | 本轮状态与公开交集                                                        | 行为验证入口及限制                                                                                                             |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 登录、项目与环境授权 | access 公开合同保留；内部身份、宿主投影、业务策略与资源装配分开           | access、project-memberships、workspace-scope、rpc.principal；仍使用既有账号来源                                                |
| 宿主与生命周期       | BusinessRuntime 接入实际 T3 Effect；停止接单、排空与释放分阶段            | t3-business-lifecycle、BusinessRuntime、RemoteDeviceService.lifecycle；真实服务器信号退出仍需发布时验收                        |
| 工作区               | 原公开服务保留；正常关闭排空队列，显式强制取消等待本地 worker 退出        | t3-workspaces、t3-business-lifecycle；继续单实例写入                                                                           |
| 发布与源码           | 部署服务经 RepositoryService 公开端口固定源码；不改写构建器，不穿透源码锁 | source-cooperation、deployment-lifecycle、deployment-workspace-source、t3-deployments；未更换引擎持久格式                      |
| 技能                 | 目录读取与变更由所属控制器拥有；页面拥有选择、对话框和导航                | SkillLibraryAccess.browser、skillLibrary、t3-skills-management；仍复用原生技能执行                                             |
| 资料与成果           | 资源元数据、计划保存和技能上下文使用已有统一客户端；成果存储纳入宿主释放  | businessRequests、t3-resources、t3-business-tools；原生二进制与历史草稿恢复保留原协议                                          |
| 前端宿主与工作区展示 | 快照、会话范围、文件浏览与阅读偏好各自拥有状态；公开出口保持              | hostConfig、apiClient、WorkspaceFileBrowser.browser、ProjectAreasResponsive.browser、WorkspaceSubmission.browser；无新增页面壳 |
| 客户本机             | 停止接单后不接受新执行，原有收据与断线落盘保留                            | RemoteDeviceService 生命周期/安全、customer-agent 分发；门禁拒绝打包平台后端                                                   |
| 部署 Agent           | 保持原中心协议与本地执行所有权；上游停止不伪造远端成功或取消              | agent、integration-protocol、source-cache；本轮不执行真实远端发布                                                              |
| 模型、偏好与导航     | 保留原生模型与用户状态；偏好数据库由宿主统一释放                          | t3-models、t3-preferences、t3-settings-preferences、t3-project-navigation；未引入新执行器                                      |
| 独立 AutoOps 后端    | 保留独立合同、身份、权限、审计和升级切片                                  | verify:autoops；未替换线上身份与存储                                                                                           |

关闭配置：AUTOOPS_SHUTDOWN_DRAIN_MS 默认 30000 毫秒，允许 1000–120000 毫秒。它是优雅排空预算，超出后记录未完成模块并协作取消本地工作区任务；部署已经接受的本地落盘仍需完成，不能在后台继续写入时提前关闭数据库。此配置不是整个进程的硬退出上限；最终强停由部署监督器的退出预算负责，重启后仍按持久收据核对远端结果。

本轮尚未切换服务器，线上最后一次已核实发行仍为下文 81a5c2f8。代码检查、Linux 回归与线上验收分别记录，不能将上次部署证据复用于本轮代码。

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
