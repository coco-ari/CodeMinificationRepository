# 当前运行模块与检查入口

这里记录当前分支的实现及调用边界，不替代[开发规范](README.md)。线上工作台仍由 `agent-demo` 网关、锁定 T3 和业务适配器组成；独立 `autoops/server` 的账号与项目后端另用 `verify:autoops` 验证，尚未替代线上身份或数据。历史目录中仍被调用的能力继续保留。

## 启动与装配

- `pnpm start:agent-demo` 启动[网关](../agent-demo/server.mjs)，T3 模式由 `AGENT_DEMO_ENGINE=t3` 选择；网关负责登录、同源 HTTP/WebSocket 代理与静态资源，不拥有 T3 轮次。
- `pnpm start:agent-demo:t3` 通过[启动器](../scripts/start-t3-worker.mjs)装配锁定 T3 worker，监听回环地址。`DATA_DIR`、`AUTOOPS_T3_BASE_DIR`、`AUTOOPS_T3_PORT` 及外置凭据沿当前部署配置提供；不得用测试默认值覆盖已有服务。
- T3 [HTTP 适配入口](../vendor/t3code/apps/server/src/autoops/http.ts)、[RPC 适配入口](../vendor/t3code/apps/server/src/autoops/rpc.ts)及客户接入入口，从认证请求取得身份后调用业务适配器。T3 原生会话、命令、事件及恢复仍由上游服务拥有。
- 前端从 [hostConfig](../vendor/t3code/apps/web/src/autoops/hostConfig.ts)接收可信 bootstrap，通过当前 T3 路由与公共框架组合页面。组件不读取服务端表或凭证。
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
- 项目成员和环境授权复用 [project-access.mjs](../agent-demo/t3-adapters/project-access.mjs)。工作区与部署服务只在完成授权后操作自身数据；后台任务接受和执行阶段仍校验调用者范围，退出页面不改变任务所属身份。
- 部署中心通过 [deployment-projects.mjs](../src/deployment-projects.mjs) 的公开用例提供项目同步、目标创建和领取归属查询；业务适配器不直接读取或修改 DeploymentService 的存储内部状态。
- T3 原生附件通过宿主 [resourceCatalog.ts](../vendor/t3code/apps/server/src/autoops/resourceCatalog.ts) 注入公开读取端口；resources.mjs 只负责业务授权与资料投影，不反向导入 attachmentStore，也不查询其他模块的表。
- 前后端 DTO 归 [autoops/contracts](../autoops/contracts)；[apiClient.ts](../vendor/t3code/apps/web/src/autoops/apiClient.ts) 统一请求和错误，工作区轮询与页面错误由所属 hook/ModuleErrorBoundary 管理。它们不改变 T3 会话执行与恢复来源。

## 可执行门禁

准备 Node.js 24.22.0、根锁定 pnpm 与 T3 锁定工作区依赖；Linux 是部署及完整运行链路 CI 环境。首次安装：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir vendor/t3code --filter "@t3tools/monorepo" --filter "@t3tools/web..." --filter "t3..." --filter "@t3tools/scripts..." install --frozen-lockfile --ignore-scripts
pnpm --dir vendor/t3code/apps/web exec playwright install --with-deps chromium
```

| 命令                            | 覆盖范围                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| `pnpm check:runtime:boundaries` | 递归发现运行代码、依赖规则与解析覆盖核对；新增子目录自动进入                |
| `pnpm check:runtime`            | 门禁文件格式、根脚本语法、根/Web/Server/客户程序类型、运行模块依赖          |
| `pnpm test:runtime:node`        | 递归执行根与适配器 Node 测试、运行边界负例；包含原部署引擎及网关测试        |
| `pnpm test:runtime:server`      | T3 `src/autoops` 下的实际服务、权限、客户事件及恢复测试                     |
| `pnpm test:runtime:web`         | T3 Web `src/autoops` 的单元与浏览器组件测试；不是所有上游 UI 测试           |
| `pnpm test:runtime:customer`    | 先打真实客户 ZIP，再测客户执行、传输与离开仓库后的分发运行                  |
| `pnpm verify:runtime`           | 上述检查与测试，并构建当前真正使用的网页；本地与 `runtime.yml` 使用同一入口 |
| `pnpm verify:autoops`           | 独立新后端的完整检查；由原 `autoops.yml` 保持执行                           |

`verify:runtime` 不调用模型、不连接真实部署目标、不执行远端重启，也不构建桌面、营销站或完整上游产品。发布前仍须按受影响范围打包 T3 服务端，并执行真实环境健康、静态文件、数据保留及跨模块交互验收；模拟测试不能替代这些验证。

## 边界检查的准确范围

检查器递归扫描 `agent-demo/`、`agent/`、`src/`、`autoops/contracts/`、T3 Server `src/autoops/` 和 T3 Web `src/autoops/` 的 JS/TS/JSX/TSX 运行源码。测试、声明文件、依赖安装目录、运行数据及构建输出不作为生产源入口；唯一额外排除的 `agent-demo/customer-agent/live-validation.mjs` 是需要真实环境的手动验收程序。它不进入产品分发，客户 ZIP 另有全部分块依赖审计。

静态分析保留类型导入、动态导入和 T3 的 `~`/`@` 路径别名。禁止扫描范围内循环、未解析依赖、前端引入后端/Node、业务服务反向导入 T3 入口、执行引擎反向导入工作台、客户执行带入平台存储、部署内部被深层引用、HTTP 内部被穿透或反向依赖入口，以及共享请求层反调界面。新增业务子目录与文件无需手动列清单；根目录为空、源码漏扫或被停止遍历时必须失败。

锁定 T3 其余源目录和依赖包作为外部节点保留直接依赖边，不递归审计其全部内部结构；`web/src` 的历史页面也未纳入本项架构扫描。T3 Web/Server 类型与相关测试继续覆盖实际引用，但不能将本门禁表述为上游全仓架构检查。`Worker` 的文件 URL、运行时路由和 SQL 访问边界还需合同、执行及行为测试，依赖图本身不证明授权正确。

Windows 上的目录 fsync、POSIX 权限、静态站点符号链接和 shell 构建用例目前存在环境差异；缺浏览器、沙箱写权限及有实际错误的测试必须分别报告。不得为获得绿色结果跳过后宣称完整链路通过，也不能用 Windows 失败替代 Linux CI 的实际结果。

## 当前运行限制与后续收敛

- 当前工作区文件存储按单个服务进程写入；PID 与进程实例标记用于恢复本实例遗留任务，对其他仍存活 PID 采用保守保留。尚未提供多实例租约，不得部署多个共享该目录的写入 worker。
- 工作区、部署业务 store 已提供关闭能力，HTTP 组合根尚未完成统一的优雅关闭装配。本次程序切换必须先核实会话、部署和工作区任务全部空闲，停止网关后再核对一次；不能把进程退出后的任务恢复等同于完整排空能力。
- hostConfig 仍含会话绑定与 fork 请求，部分资料元数据读取仍有独立传输路径。后续拆出 bootstrap 快照与会话范围客户端，再归入统一请求边界，避免 apiClient 与 hostConfig 循环依赖。
- 工作区文件浏览面板、技能目录控制器仍有继续细分的空间；当前公开入口、授权与回归保持有效。不得以此为由重写原生 T3 文件、会话或技能执行器。
- 共享服务器上安装依赖或验收，必须使用独立 cgroup 的总内存限制并串行执行；只设置 V8 堆上限不能保护线上进程。构建优先在开发或 CI 主机完成，验收只使用隔离数据目录。
