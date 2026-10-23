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

| 模块                 | 唯一状态所有者与实际公开协作                                                                           | 必要依赖及失败影响                                                                                        | 本轮实际验证与未闭环项                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 登录、项目与环境授权 | 网关拥有登录/CSRF；access 公开门面拥有业务范围与绑定                                                   | 所有业务入口经 access 裁决；身份或共享存储失败时拒绝依赖操作                                              | CI 权限回归；匿名 401、外部部署 403、跨项目 404、旧配置 409 已实测；真实切项目、切身份与迟到响应隔离通过                                  |
| 宿主与生命周期       | BusinessRuntime 装配 runtime.initialize/drain/close；各模块拥有自身资源                                | 停止接单后先排空再释放；远端任务不能由宿主退出推断结果                                                    | 新版空闲 SIGTERM/重启及数据保留通过，修正 systemd 的正常中断识别；本机真实配置宿主活动 SIGTERM 排空通过；线上远端原任务跨中心重启收据通过 |
| 工作区               | workspaces.mjs 公开服务拥有版本、文件索引与任务；HTTP 仅调用公开方法                                   | 授权、受限文件操作与打包 Worker；单任务失败保留已发布版本                                                 | 固定包生成/下载、示例脱敏生成/复核、幂等、外部越权与原内部版本保留通过；取消及失败收据通过；合法导入预算扫描缺陷已修复待发布复验          |
| 发布与源码           | DeploymentService 拥有配置/任务/记录；RepositoryService 拥有源码和持久格式                             | 经 captureArchive、pinRevision、releasePin、cachedCommitSubject、waitForIdle 协作；源码失败不伪造发布成功 | 真实构建、同请求去重、手动回退、健康失败恢复通过；恢复失败与显式再次恢复通过；浏览器未知提交响应待验                                      |
| 技能                 | skill-library/scoped-skills 拥有不可变包与授权快照；useSkillLibraryCatalog 拥有页面目录请求            | access 与原生技能目录；读取失败阻止新选择，历史标签不代表当前仍获授权                                     | 真实导入/发现/隔离、固定版本和停用拒绝通过；换版标签缺陷已修复，专项 UI 3/3；真实系统焦点及停用后迟到响应拒绝通过                         |
| 资料与成果           | resources/business-tools 拥有业务投影与成果；原生附件仍由 T3 拥有                                      | 经 resourceCatalog 公开读取端口和 access 授权，不穿透附件库；拒绝请求不返回旧资源                         | 真实资料读取、原文复制、固定版本预览及范围隔离通过，原成果保留；真实私有 Markdown/PDF 创建、下载和删除后拒绝通过                          |
| 前端宿主与工作区展示 | hostSnapshot/threadScopes、WorkspaceFileBrowser、workspaceViewState 分别拥有快照、范围、文件与阅读偏好 | 统一 apiClient、服务端 DTO 和 T3 公共框架；局部加载失败由模块错误边界呈现                                 | 公共框架 10/10、部署 UI 8/8；长路径和跨项目阅读恢复的当前版本组合待验                                                                     |
| 客户本机             | 客户进程拥有目录、凭据、原生执行与待回传记录；中心拥有业务绑定和投递收据                               | 只经客户传输合同协作；断线不释放未知占用、不伪造停止                                                      | 真实 macOS 设备执行、技能、隔离、重启与强制退出核实通过；活动断线后原事件补报通过                                                         |
| 部署 Agent           | 现有 Agent 拥有目标机执行与恢复；中心只接收公开协议收据                                                | Docker/Nginx 与固定源码包；本机失败上报真实恢复状态，中心停止不等于取消远端动作                           | 本轮专用测试目标真实发布/回退/失败恢复通过；真实跨中心重启、未确认事件补报及恢复失败通过                                                  |
| 模型、偏好与导航     | 原生 T3 拥有模型轮次与偏好；业务模型目录只提供既有能力                                                 | CPA 元数据暂不可达可复用上次目录，执行仍独立验证模型；导航不重绑已接受任务                                | 实际 CPA 技能及内外部资料读取通过；UI 刷新恢复同一部署任务；真实流式上读位置通过；跨页面代码阅读缺陷已修复待发布复验                      |
| 独立 AutoOps 后端    | 独立账号、项目、环境、权限、审计与升级切片                                                             | 仅经 autoops/contracts 共享纯合同；不与当前线上双写                                                       | verify:autoops 对应 CI 通过；未切换线上身份和存储，不把启用新后端列作本轮补建                                                             |

关闭配置：AUTOOPS_SHUTDOWN_DRAIN_MS 默认 30000 毫秒，允许 1000–120000 毫秒。它是优雅排空预算，超出后记录未完成模块并协作取消本地工作区任务；部署已经接受的本地落盘仍需完成，不能在后台继续写入时提前关闭数据库。此配置不是整个进程的硬退出上限；最终强停由部署监督器的退出预算负责，重启后仍按持久收据核对远端结果。

本轮已将完整程序、网页和客户 ZIP 发布到独立验证入口 `192.168.31.157:28887`，当前应用提交为 `b6f25a04dcf418c31535269644e029e65b46dceb`。先发布完整基线 578a51f3，再根据真实验收修复技能标签并发布 b6f25a04；两批证据分别记录，未受影响的业务回归不重复执行。

## 本轮修复与当前发行（2026-10-23，b6f25a04）

真实目录换版时，业务授权快照已经更新，原生技能目录尚未就绪，`ChatComposer` 用两份目录交集生成展示标签，导致草稿标签暂时退回 `$技能名` 文本。现由 `skillContextDisplaySkills` 将公开授权上下文转换为展示项，沿用固定快照的说明地址；候选选择仍按当前授权与原生目录筛选。没有授权上下文时返回空列表，不借展示信息放宽读取权限。

| 证据层次         | 实际结果                                                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向回归         | macOS 技能查询、标签浏览器回归与映射单元测试 20/20；新增换版后的标签、光标、序列化、固定说明地址和无上下文断言；Web 类型、网页构建、176 文件边界与脚本语法检查通过                                                                                                         |
| Linux CI         | [运行链路 39949032576](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39949032576) 与 [独立后端 39949032587](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39949032587) 均通过；上游完整 T3 测试与 Windows 实机不在本轮执行范围 |
| 当前发行         | 完整目录 `/home/tao/autoops-agent-demo/releases/t3-step2-b6f25a04`；5333 文件、61 相对链接，官方同版原生依赖 2038 文件/21 包校验通过；网页 HTML 与 `application-release.json` 应用提交分别核验。健康中的 sourceCommit 表示锁定上游，不能充当应用提交                       |
| 切换与保留       | 空闲时备份并切换网关/Worker，沿用原数据；切换瞬间已有 54 消息、17 运行、172 轮次条目、8 绑定、1 成果、185 工作区/技能文件及 8 部署任务均保留，其他四项服务 PID 不变                                                                                                        |
| 线上专项交互     | `chips-ui-complete/report.json` 3/3：原生选择、真实 HTTP 失败后保留标签与光标，目录换版及刷新后读取当前说明，真实模型发送后的历史标签、剪贴板原文复制和固定工作区文件预览。焦点刷新由浏览器事件触发，不等同于操作系统窗口切换；页面无未处理错误，临时技能和会话已清理      |
| 最终原始数据审计 | 交接前历史行及 159 个原文件均存在；157 个文件摘要未变，两个索引中的原条目逐项保留，仅允许新增验收记录；原部署任务、发布记录、配置、源码包字节与来源引用保留，去重包仅新增本轮来源                                                                                          |
| 健康及程序恢复   | 当前网页入口、Worker 健康、客户 ZIP 摘要与匿名拒绝复核通过；`backups/t3-step2-b6f25a04-20261023/rollback-program.sh --check` 通过，可回到 578a51f3 程序并继续使用当前数据；未执行程序降级                                                                                  |

本补丁未改变后端业务逻辑，继承下方完整基线的真实发布/回退与数据验收。当前无凭据证据为 `.deployment/step2-578a51f3-evidence/result-b6f25a04.json`、`api-smoke-b6f25a04.json`、`final-original-retention.json`；专项截图与操作报告在 `.deployment/step2-build-578a51f3/.test-artifacts/step2-578a51f3/chips-ui-complete/`。该独立构建快照已同步补丁源文件，目录名仍保留初始基线。

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

### 第二步收尾实证（2026-10-23，持续更新）

用户已授权将当前 macOS 开发机作为真实客户电脑接入 Linux 验证中心。客户连接程序使用已发布 ZIP、本机已登录的 Codex CLI 和独立临时工作目录；不上传个人目录或将平台凭据交给客户执行器。以下为本轮新增实证，未完成项仍在下节列出。

| 范围             | 已核实的结果与证据                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户真实执行     | macOS → LAN → Linux 中心，实际发现本机模型与专用技能，完成两轮真实文件写入；客户目录与会话绑定固定，外部账号不能读取私有绑定。证据：`.deployment/step2-closeout/customer/setup-report.json`、`baseline-report.json`                                                                                 |
| 客户退出与核实   | 空闲退出后新进程恢复同一原生会话并写文件；活动时第一次退出被保护，第二次强制退出保留 unknown 与目录锁。确认本次受管子进程全部结束后，用公开 resolve 命令核实原 run/attempt，中心得到 cancelled、释放占用，未新增轮次、未执行延迟写入。证据：`resume-report.json`、`verify-forced-exit-report.json`  |
| 客户断言修正     | 首次脚本误期望人工核实结果为 failed/interrupted；实际公开恢复合同映射为 cancelled。保留原失败记录，修正断言后只读核对原任务，未重复执行故障轮次；不将测试断言错误列为产品缺陷                                                                                                                       |
| 身份与迟到响应   | 真实切项目、管理员退出再登录外部账号，放行先前截留的真实 HTTP 200 响应均不能恢复旧范围内容；外部账号实际请求内部资源返回 403。证据：`.deployment/step2-closeout/ui/isolation/report.json`                                                                                                           |
| 流式阅读         | 真实模型输出期间上读到 top=0，连续 78 次采样保持位置，内容高度从 1917 增长至 3146；专用会话已清理。证据：`ui/stream-trace/report.json`                                                                                                                                                              |
| 成果报告         | 私有会话实际生成 Markdown 与 PDF，所有者下载并回读中文及唯一标记；其他管理员与外部账号 404、匿名 401，删除本轮会话后原下载链接 404。证据：`workspace/report-acceptance.json`                                                                                                                        |
| 导入失败与取消   | 非法来源拒绝且不建任务；无效分支失败后相同请求返回原失败、改参数 409；真实取消得到 interrupted/cancelled，重复取消及原请求重放不重启。合法仓库首次失败于存储预算扫描，未产生半成品版本。证据：`workspace/import-report.json`                                                                        |
| 本地真实信号排空 | 独立配置业务宿主收到实际 SIGTERM 时仍有 2 项 packaging、4 项 queued；停止接单后 122ms 排空 6 项任务并生成 12 份 ZIP，资源关闭、自然退出。新进程读取同任务及一致摘要、同请求不新增任务。证据：`workspace/lifecycle/report.json`；该证据来自 macOS 隔离宿主，不称为线上完整 T3 宿主的活动任务信号实测 |

客户活动断线新增实证：仅停止专用网关，Worker 与本机执行器保持运行；本机在中心不可达期间完成文件写入，事件 `tail=68 / ack=46` 持久保留，重连后 `ack=68`，同一轮次完成且未重新提交。报告为 `customer/disconnect-network-report.json`。首次保护脚本误将不含 threadId 的原生 attempt/turn 识别为外部活动而拒绝停机；已按真实引用关系修正并保留首次报告，不将未形成断线的那轮计为通过。

线上恢复演练：任务 `2186adb5-ee18-455b-b7fc-de42444c8caa` 在中心停止期间成功，原 Agent 记录 `seq=30 / ackSeq=24`；重启后确认到 30，日志连续，原请求仍对应原任务。首次 180 秒监控预算不足是 Docker 新镜像层仍在下载，业务任务没有失败；随后仅续验原任务。真实恢复失败任务 `995a842d-9015-4aba-befc-e95b369ee511` 返回 `failed / rollback.failed`，清除候选与基线的精确健康故障后，显式恢复任务 `0683d5ba-8447-4c92-8da4-9d3050b6c023` 成功，原失败历史保留。证据为 `recovery/report.json`；故障规则已清空，站点正常、四项无关服务 PID 不变。验收 harness 各自处于 512MiB/no-swap cgroup，实际构建容器采用 1024MiB 上限；Docker daemon 本身不受 harness 总限额约束，不能混称。

真实系统焦点与停用组合也已通过：独立 Chrome 窗口之间产生可信 blur/focus 与实际焦点变化，技能标签及光标保持；技能停用后原固定说明返回 403，加载新授权目录后才释放暂存的旧 200 响应，旧候选与标签均未恢复。证据为 `ui/focus-revoke-real/report.json`；本轮临时技能、浏览器与 profile 已清理。

验收新增发现两项实现缺陷：Git 导入的周期容量扫描不容忍克隆期间临时文件消失；代码文件的 Pierre Virtualizer 未纳入工作区滚动视口采集，切页面后阅读位置回到顶部。前者通过真实文件消失的确定性回归复现，修复仅容忍子项 ENOENT，仍拒绝根目录消失、权限/I/O 错误、超限和符号链接；发布固定快照继续严格扫描。线上首次失败未记录具体 errno，不能将竞争复现冒充该次线上错误日志。后者以真实固定文件、滚轮及切页复现 top=800 → 0，修复复用原生文件模块的公共视口入口并等待异步尺寸；最终回归和发行结果在后续证据中记录。

### 最终复验进展（2026-10-23）

完整发行 `61e9ed11cd4cc5f97a2cbc368a78b74c0f53bedd` 已部署，运行链路 [39958840075](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39958840075) 与独立后端 [39958839943](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/39958839943) 均通过。Linux 运行链路为 Node 415、Server 106（另 2 跳过）、Web 167、客户 17；Markdown 定向三组 179/41/20，另 88 项非本门禁目标跳过。发行清单 5495 文件、61 相对链接和官方原生依赖校验通过，实际 CLI 与隔离打包 Worker 启动通过。

切换脚本运行 12.215 秒，沿用原数据并保留 206 个工作区/技能文件、客户设备与目录绑定、1 个传输会话、12 个命令及 3 个游标；其他四项服务 PID 不变。程序回滚预检通过，未实际执行程序降级。随后对首批发布前原始数据复核通过：159 个原文件仍在，157 个摘要未变，两个索引原条目保留；原历史、部署配置与源码包也保留。证据为 `release/switch-final.log`、`rollback-ready-61e9ed11.json`、`retention-61e9ed11.log`。

合法导入已在该版真实完成，固定 Git 提交 `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`、读取与下载一致、原请求去重、失败后显式新请求恢复均通过。另在观察到 running/fetching 后取消，保留 interrupted/cancelled 收据、不产生半成品版本；旧失败任务保持原结果。证据为 `workspace/import-fixed-report.json`、`import-active-cancel-report.json`。

浏览器未知提交结果也已实测：真实回退请求被服务接受后丢失响应，界面明确显示待核对，刷新保留原请求；再核对返回原任务且不新增任务。随后仅重放同一请求补齐错误提示出现时序断言。证据为 `ui/deployment-unknown/report.json`、`deployment-unknown-reconcile/report.json`。静态截图发现核对按钮被 T3 Alert 误当作图标槽，现将文本与按钮放入公开 AlertDescription；权限和原请求语义保持不变。

跨页面阅读已在线恢复到 top=800；冷刷新仍归零的原因另由实际时序证明：环境未就绪时文件区未挂载，之后环境到达却未重新安装恢复监听。现将环境标识加入该 effect 依赖，并补充 null 到就绪的回归；本补丁尚待最终发行与线上复验。追踪脚本早期 observer 注入错误属于测试诊断问题，原始复现无页面错误，原失败记录继续保留。

### 第二步尚未闭环

- 导入预算扫描、原生代码视口及响应式纵横阅读位置已发布并完成对应 CI；新增的冷刷新恢复与 Alert 按钮布局补丁仍需最终 CI、完整发行和线上复验。
- 客户本机真实接入、执行、技能、空闲重启、活动退出保护、未知结果人工核实与断线补报已闭环；专用设备保持登记，未因此扩大到个人其他目录。
- 线上活动远端部署跨中心重启、恢复失败及显式再次恢复已闭环；本机配置宿主 SIGTERM 活动排空有独立证据。浏览器提交响应丢失后的未知态、刷新与原请求核对已通过。
- 问答与技能的真实流式阅读、系统焦点切换、撤权与迟到响应组合已闭环；工作区合法导入成功、失败后恢复与跨页面阅读已通过，冷刷新阅读和新提示布局等待最终发行复验。
- 平台边界：已覆盖 macOS Chromium、Linux 实际服务及 390px 触屏视口；Windows 实机、实体手机、普通公网 HTTPS、整套 T3 上游测试未执行，不能混称本轮验收通过。

因此第二步仍在验收收尾，不能宣布全部完成。多实例、新身份后端接管和新增业务功能不作为本轮补建项。

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
