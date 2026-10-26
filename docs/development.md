# 开发与验证

先读 [AGENTS.md](../AGENTS.md)，再按 [规范索引](README.md)选择专项。业务计划及最新三步顺序见[完整计划](../examples/autoops-rebuild-plan.md)，已有基础模块见 [AutoOps 模块入口](../autoops/README.md)。

## 当前状态

**第二步：当前已实现模块的深度优化、部署验收与收尾已完成（2026-10-23）。** 当前发行与恢复配置统一见[当前验证发行](../examples/agent-demo-t3-deployment.md#当前验证发行)，完成依据及未测边界见[第二步最终验收](runtime-modules.md#第二步最终验收)。 第一阶段的规范基线 v1 保持有效；用户已授权实施第二步并部署预览。 当前 `feat/workspace-deployment-validation` 分支是唯一运行基线。2026-10-25 用户明确要求专项核对 main 部署核心；已按固定提交整理[完整能力与适配方案](../examples/deployment-core-adaptation-plan.md)，用户已确认按四批推进迁移实现，并明确删除旧 Jenkins／脚本直取源码及其下载口令能力，不合并整条 main 分支，也不补迁无关功能。

| 步骤 | 当前状态与边界 |
| --- | --- |
| 1：完善规范 | 已完成；后续按实际实现补充模块入口和验证方法，业务约束仍由专项规范维护 |
| 2：全部现有模块深度优化 | 已完成当前功能基线内的模块职责、数据归属、公开协作与失败边界梳理；权限、工作区、技能、源码发布、宿主生命周期与真实客户电脑流程已有分层验收证据，验收发现的缺陷已修复并部署；保留单实例与既有身份/存储，不补建未来能力 |
| 3：后续功能开发 | 当前资料与独立 Git 部署来源已接入并部署测试服务器；两个公开仓库真实同步及 Agent 资料读取已验，用户仓库的独立部署包成功路径仍待网络恢复后补验 |

此前已提交独立的 `autoops` 后端切片：空库初始化、真实本地账号与登录会话、项目/环境/成员、统一范围授权与 capabilities、必要审计、SQLite 升级、幂等创建、自动质量检查与 CI。它对应早期计划阶段 1 的后端部分；成果保留，第二步同样核对其符合性。不能把这批代码通过检查理解为全部模块已优化。

该后端切片尚未接入前端、工作区文件、部署执行、T3 会话和客户本机；相关权限测试只证明裁决规则。现有工作台继续由 `agent-demo`、`vendor/t3code` 与业务适配器运行，实际已有能力均计入当前功能基线。目录名和历史实现方式不构成删除功能的理由。本轮预览继续使用这条运行链路，不启用独立后端的空库初始化，也不迁移或清空正在使用的数据。

`src` 和 `agent` 仍是实际部署引擎和执行器；`web` 包含当前托管入口及保留的原型。已完成调用核对，不能按目录名称删除。历史启动记录见[历史平台说明](history/legacy-platform-readme.md)，不能把历史命令当成独立 `autoops` 切片的启动方式。

2026-10-26 已确认的[项目总图与简化权限](../examples/project-workbench-design.md#项目权限设计)属于下一批目标设计：固定角色和环境覆盖已接入当前运行策略；助手参数调整、环境 MCP 继承及完整统一请求裁决继续实施与验收，不将独立后端切片测试、旧原型或局部门禁视为完整方案已上线；存量授权需先核对，不能因简化而自动扩权。

同日确认[统一助手与用户运行来源](../examples/project-workbench-design.md#统一助手与用户提供的运行来源)：自用电脑纳入助手预设；提供者可主动共享到项目，再由管理员分配。跨用户执行、统一管理入口及受控平台资料/MCP 接入仍须实现与验证；现有客户自用、附件与文件能力保留，不把本次设计当成已开放共享执行。

### 总体规划接手实施（2026-10-26）

接手基线为本工作树 `feat/workspace-deployment-validation` 的 `5b425242`，远端领先状态为本地多一个已提交设计变更，未提交文件为零。继续使用 agent-demo → T3 → 业务适配器；没有合并 main、启用独立后端或变更使用中的数据。

第一切片修复现有部署 HTTP 异步读取的返回前授权缺口，验收见[部署读取撤权回归](runtime-modules.md#部署读取撤权回归2026-10-26)。该修复不迁移成员角色，不表示新权限方案已接入。后续仍依次实施：固定角色与环境覆盖及统一问答参数合同 → 项目/环境集中配置 → 助手与真实运行能力 → 当前资料生命周期及部署剩余流程 → 整页和真实业务验收。存量授权扩大前需形成明确映射，不将现有 manager/member 规则或独立后端测试当作新权限已经生效。

### 完整交付实施清单

本次交付覆盖已确认总体规划的完整实施与验收，批次完成后直接继续下一个依赖已满足的批次。以下按当前实际运行链路记录，状态随实现及证据更新；“待验证”不等于已验收，“已实现”也不代表整套产品已完成。独立 `autoops/server` 的测试不替代当前运行链路。起点保留 `a2b8d768`；该提交两项 [质量 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40222937482) 与 [运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40222937477) 通过。

| 编号 | 交付项 | 状态 | 现有代码与证据、剩余验收 |
| --- | --- | --- | --- |
| A1 | 固定项目角色、显式环境角色覆盖及账号分类 | 已实现 | [同源合同](../autoops/contracts/project-access.ts)、[运行策略](../agent-demo/t3-adapters/project-access.mjs)、[角色回归](../test/t3-project-roles.test.mjs)、[真实 HTTP/引擎](../test/t3-deployments.test.mjs)；显式环境角色覆盖默认，项目/环境动作分离。成员持久管理与整页验收仍分别归 B1/E1 |
| A2 | 页面、HTTP/RPC/MCP、下载与后台执行统一授权 | 待验证 | [access](../agent-demo/t3-adapters/access.mjs)、[消息/轮次身份回归](../test/t3-request-actors.test.mjs) 及原生 RPC/MCP 已接入实际调用者，排队编辑按 T3 已提交事件裁决，下载/后台角色边界复用已闭环入口；完整问答参数和环境 MCP 仍分别随 A3/A4/B5/B6 验收 |
| A3 | 异步读取撤权、跨环境伪造与原地址恢复 | 已实现 | `a2b8d768`；[回归](../test/t3-deployment-response-access.test.mjs) 与[验收](runtime-modules.md#部署读取撤权回归2026-10-26)，尚未随本批发行部署 |
| A4 | 统一问答最终参数合同、调整权及受限预设校验 | 待验证 | [最终参数](../autoops/contracts/assistants.ts)、[绑定/RPC](../agent-demo/t3-adapters/access-service.mjs)、[原生队列](../vendor/t3code/apps/server/src/autoops/questionCommands.ts) 已接唯一问答入口，原生已固定模型、排队恢复、实际调用者及所选技能按同一合同复核；服务/原生回归通过，浏览器与真实发行、旧会话映射待验，见[本批证据](runtime-modules.md#统一问答最终参数接入2026-10-26) |
| A5 | 存量权限映射、私有内容及撤权后的历史阅读 | 待验证 | 用户已选择林晓/陈一先不启用新授权；[目录](../agent-demo/fixtures.mjs) 显式标记待分配，仅保留原使用边界，后续由管理员保存分配。外部不绑定新环境，历史自用电脑仍保留原身份/未知收据。自动负例已覆盖，服务器存量实测待最终发行 |
| B1 | 项目基本信息、成员和环境的持久管理及统一入口 | 待验证 | [项目目录](../agent-demo/t3-adapters/project-directory/index.ts) 已将存量项目/环境/成员一次导入自有版本化数据库，授权读取当前事实；[页面](../vendor/t3code/apps/web/src/autoops/ProjectsPage.tsx) 已接入创建、基本信息、环境添加/编辑和成员状态。SQLite/HTTP 正反例已过，浏览器在 `23003b65` 的[运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40249611790) 通过；成员固定角色/环境覆盖、默认助手准入及分配表单已接 API，`9dc39661` 的[运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40253068408) 全部交互通过；新项目默认空资料初始化已修复，原示例和已有内容保留，见[本批证据](runtime-modules.md#新项目空资料初始化2026-10-26)；删除与公开引用预检、原生持久删除及环境授权同事务清理已接，新增服务/HTTP/请求恢复通过；删除浏览器、完整配置与真实发行待验。不切换独立后端或清空业务库 |
| B2 | 项目仓库连接与工作区/部署分支配置分离 | 待验证 | [连接合同](../autoops/contracts/project-repositories.ts)、[authoring](../agent-demo/t3-adapters/workspace-authoring/index.ts) 的 v3 升级及[原生项目 API](../vendor/t3code/apps/server/src/autoops/http/repositories.ts) 已拆分唯一连接与工作区引用，保留现有 ID/分支/捕获；集中仓库/凭证及工作区使用交互在 `97a7945f` CI 通过。部署现独立读取项目连接并提交自己的版本和目录，未加入工作区也可打包，旧组合入口已移除；新增部署交互已在 `5a9703e3` 的[运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40266628636)通过；真实私有 Git、存量来源重新确认和服务器发行待验；[本批证据](runtime-modules.md#项目仓库连接与工作区引用拆分2026-10-26) |
| B3 | 项目凭证创建、替换、撤销及受控使用 | 待验证 | [credentials](../agent-demo/t3-adapters/credentials.ts)、[回归](../test/t3-workspace-credentials.test.mjs)；[集中入口](../vendor/t3code/apps/web/src/autoops/ProjectCredentialsPanel.tsx) 复用秘密仅留内存及原收据核对，工作区改为跳转唯一入口；新交互在 `97a7945f` 的[运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40264887443)通过，真实私有仓库成功、撤销、失败恢复仍待验 |
| B4 | 平台全局节点管理与项目已获准节点绑定 | 待验证 | [节点准入](../src/deployment-projects.mjs)、[全局原生 API](../vendor/t3code/apps/server/src/autoops/http/deploymentNodes.ts) 已区分平台管理与项目准入绑定，存量只继承已有绑定；新增[服务回归](../test/t3-node-project-access.test.mjs)及[真实 HTTP](../vendor/t3code/apps/server/src/autoops/http/deploymentNodes.test.ts)已通过。全局入口、项目准入确认及环境绑定页面已接同一节点弹窗；新增浏览器成功/拒绝/异常恢复及零项目全局入口在 `7110d150` 的[运行 CI](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40271621753)通过；真实节点、整页及发行未验，整项待真实验证，历史测试不替代新方案验收 |
| B5 | 环境 MCP 唯一配置入口、只读连接、测试与停用 | 待验证 | [连接所有者](../agent-demo/t3-adapters/environment-mcp/index.ts)、[真实协议驱动](../agent-demo/t3-adapters/environment-mcp/drivers/index.ts)、[环境页面](../vendor/t3code/apps/web/src/autoops/EnvironmentMcpDialog.tsx)已接中央凭证、修订测试、启停、移除及原收据；真实 SSH 7 项、Redis 9 项及 MySQL 双 SQL 模式参数读取通过，新增浏览器和发行 CI、已部署问答仍待验；[本批证据](runtime-modules.md#项目删除与环境只读连接2026-10-26实施中) |
| B6 | 环境 MCP 随问答和环境授权使用、迟到结果与撤销 | 待验证 | 原生工具按本轮持久调用者和固定环境读取真实连接，恢复沿原配置/凭证版本，停用/撤权拒绝；服务/HTTP跨环境负例通过。原生终态仅在核验持久来源后释放 MCP 输入，停机合成取消、未知及子任务引用继续保护；浏览器、真实角色和问答恢复待验，无逐成员逐连接授权表 |
| C1 | 平台/用户助手统一目录、预设与项目分配 | 待验证 | [统一助手页面](../vendor/t3code/apps/web/src/autoops/AssistantManagementPage.tsx) 已归并当前项目/我提供的，复用原接入和配置表单；[提供者目录](../agent-demo/t3-adapters/assistants/index.ts) 与原生 API 已接本人预设、真实来源、共享、修订分配及原收据。相关本机服务/HTTP通过，新增整页浏览器与原自用来源/真实问答待 CI 及发行；[本批证据](runtime-modules.md#统一助手管理与实际输入器2026-10-26) |
| C2 | 默认助手、低权限只读参数与调整权 | 待验证 | [实际 ChatComposer](../vendor/t3code/apps/web/src/components/chat/ChatComposer.tsx)、[原生参数检查](../vendor/t3code/apps/server/src/autoops/questionCommands.test.ts) 共用最终合同；受限参数可见、快捷键不能调整，模型/强度下线保留原选择并拒绝发送，不能自动选首项或平台默认。新增实际输入器 8 个浏览器场景待 Linux CI，真实问答待验，调整不写公共预设 |
| C3 | 实际运行器模型、强度、附件及技能能力 | 已实现 | [models](../agent-demo/t3-adapters/models.mjs)、[customer-target](../agent-demo/t3-adapters/customer-target.mjs) 与[客户能力验收](runtime-modules.md#客户默认思考档位2026-10-25)；统一助手后需重验不换模型/位置 |
| C4 | 电脑自用接入、文件、附件、可靠事件及恢复 | 已实现 | [customer-registry](../agent-demo/t3-adapters/customer-registry.mjs)、[customer-agent](../agent-demo/customer-agent)、[真实证据](runtime-modules.md#客户电脑文件引用2026-10-25)；迁入助手时保留 |
| C5 | 提供者主动共享、管理员分配、撤回和实际调用者 | 待验证 | [提供者事实](../agent-demo/t3-adapters/assistants/schema.ts)、[本人管理 HTTP](../vendor/t3code/apps/server/src/autoops/http/providedAssistants.ts) 已实现主动指定项目共享与撤回、管理者分配及修订复核，管理权不能代替本人同意；已保存后撤权只确认事实，原收据恢复不重复。服务/HTTP正反例通过；跨用户实际执行与真实身份验收继续 C6，不能将元数据配置当执行完成 |
| C6 | 跨用户电脑会话、附件、工作目录及收据隔离 | 待验证 | [中心签发范围](../autoops/contracts/shared-execution.ts)、[固定隔离运行器](../agent-demo/customer-agent/shared-docker-profile.ts)、[项目助手目录](../autoops/contracts/customer-assistant-runtime.ts) 已接入；实际调用者、来源、分配、profile 和原收据固定，外部未隔离来源明确拒绝，自用保留。Linux OS 10 项通过；发现内置模型目录与实际提供者无交集后，已补显式本机目录并由真实 CLI 返回提供者 12 个模型及强度，客户 68 项通过。完整 CI 新浏览器 604 通过、6 失败，继续修复；模型推理、选定技能、双用户附件及断线恢复和实际发行仍待验。未具备精确验证许可的来源继续拒绝跨用户执行，见[提供者模型目录与验收边界](runtime-modules.md#提供者模型目录与验收边界2026-10-26) |
| D1 | 问答读取已同步当前资料、失败保留与每轮固定输入 | 待验证 | [当前资料](../agent-demo/t3-adapters/workspace-current.ts) 已改为只读有效当前源，新轮零 Git resolve/fetch；[authoring](../agent-demo/t3-adapters/workspace-authoring/index.ts) v4 持久准备收据、原子当前指针与旧资料一次接管，失败/待切换保留原真实目录及提交。新增真实 owner/SQLite/Worker+受控 Git、越权、重启与工具读取回归 87 项通过，SQLite 并发及升级/事务相关 36 项通过；新完整 CI、浏览器和真实问答待验，[本批证据](runtime-modules.md#问答只读已同步当前资料2026-10-26) |
| D2 | 内外部各一份当前内容、手动与定期更新 | 待验证 | [更新所有者](../agent-demo/t3-adapters/workspace-updates/index.ts)、[实际组合根](../agent-demo/t3-adapters/workspace-update-runtime.ts)、原生 HTTP 与当前范围设置 Dialog 已接入；默认关闭，按真实配置者和当前来源复核，原任务恢复不重新执行，外部待复核不自动发布。28 项 SQLite/任务回归（含实际资料与权限组合）、7 项原生 HTTP、13 项 Web 请求单测通过；11 项浏览器用例待 Linux CI，实际服务器定时更新与整页验收尚未执行。证据见[定期更新验收](runtime-modules.md#当前资料定期更新2026-10-26)；D3 的活动输入回收仍独立待完成 |
| D3 | 活动/排队/未知输入临时保护、终态释放和自动回收 | 待验证 | [实际引用所有者](../agent-demo/t3-adapters/access-input-lifecycle.mjs) 与[原生生命周期](../vendor/t3code/apps/server/src/autoops/workspaceInputLifecycle.ts) 已接原命令、排队、活动/未知、子任务及可信终态；当前/部署/必要输入继续保护，旧选择与无引用资料回收，原收据不切最新输入。独立 C6 v2 组合 owner125、MCP24、原生/升级41及四类严格类型、286源边界和Worker构建通过；完整CI、真实问答/回收/断线及服务器升级仍待验，见[输入生命周期证据](runtime-modules.md#当前资料输入保护与按引用回收2026-10-26) |
| D4 | 部署独立分支、固定 Commit、完整构建上下文源码包 | 已实现 | [deployments](../agent-demo/t3-adapters/deployments.mjs)、[源码回归](../test/deployment-workspace-source.test.mjs)；仓库连接拆分后复用、真实用户仓库打包待验 |
| D5 | 版本链、配置快照、原包恢复、失败恢复与收据 | 待验证 | [DeploymentService](../src/deployment.mjs)、[Agent](../agent/main.mjs) 已有核心；[适配记录](runtime-modules.md#main-部署核心适配2026-10-25) 尚缺新增 Java/static 隔离目标完整真实验收 |
| D6 | 部署包按版本链/活动引用保留、临时包自动回收 | 待验证 | [工作区包所有者](../agent-demo/t3-adapters/workspaces.mjs)、[部署协调](../agent-demo/t3-adapters/deployments.mjs) 与 [SourceArchives](../src/source-archives.mjs) 已接实际引用、七天保留、清理重试及原收据；真实捕获所有者在操作者撤权后同步归还精确引用，未知或非 true 证明保留本批。31 项包/部署组合与 3 项所有者维护回归通过，完整 CI 和服务器实际部署/回收待验；[本批证据](runtime-modules.md#部署临时包与捕获引用回收2026-10-26) |
| E1 | 集中项目配置、环境页与统一助手整页交互 | 待实现 | 项目目录的基本页面已复用锁定 T3 外壳、SettingsGroup/SettingsRow 和 Dialog；成员分配、仓库/凭证、环境 MCP/服务器与统一助手整页仍待补齐，不能据此宣称集中配置完成 |
| E2 | 新角色成功/拒绝/撤回、参数篡改、共享与跨环境 | 待验证 | 每批增加真实服务/接口及关键交互负例，旧角色测试不能作为新规则验收 |
| E3 | 浅深色、桌面/窄短窗、长数据、滚动、键盘与焦点 | 待验证 | 现有公共壳有历史证据；新页面逐流程自动化及整页实测，记录前后全部操作次数 |
| E4 | 真实只读 MCP、私有 Git、问答与共享运行器 | 待验证 | 使用隔离资料、连接与任务；凭据或执行隔离条件缺失仅阻塞相应项，继续独立工作 |
| E5 | 隔离 Java/static 发布、重启/失败恢复/回退/断线 | 待验证 | 已授权 `192.168.31.157`；按现有运维规范核对目标、版本、数据及活动任务，不复用用户业务目标故障注入 |
| E6 | 最终发行、健康/数据保留、完整 CI 与最终报告 | 待验证 | 每批提交、正常推送并检查 CI 后继续；全部已确认项具有相应实现和真实验收证据后才报告整体完成 |

2026-10-26 状态纠正：B4、D1 最初均改为待实现，已有部分能力和历史测试仅作为复用依据。B4 随后在 `7110d150` 接完新方案并通过新增自动回归，现为待真实验证；D1 随后已接入只读当前资料并通过新自动回归，现待完整 CI 及真实验证。保持当前实施顺序，不因本次纠正重排批次。以下逐层补齐用例和实际证据；B4 新服务/HTTP 证据不代表页面与真实验收完成，D1 的本机新方案证据已补，真实问答仍待验。

| 项目 | 成功回归（待补） | 越权回归（待补） | 异常与恢复回归（待补） |
| --- | --- | --- | --- |
| B4 | 平台登记、准入后项目绑定的服务/HTTP 正例已补；观察状态、环境页绑定及独立全局入口已接入，新增浏览器已在 `7110d150` 通过，真实节点待验 | 项目管理员不能登记/修改全局节点、不能绑定未获准或其他项目节点；伪造平台角色、正文身份及准入写入的服务/HTTP 负例已补，新增页面负例 CI 通过，真实权限待验 | 准入撤回拒绝新绑定/后台领取，原收据核对、写后撤权、注销、升级损坏保护已补；离线/连接失败、原收据及完整页面恢复新增浏览器 CI 通过，真实恢复待验，不替换目标节点 |
| D1 | 同步成功后连续发送多轮问答读取当前资料，远端 Git 请求次数不增加；手动或定期同步成功后下一新轮取得更新，原轮及恢复保持原输入 | 跨项目、跨环境、内外部范围伪造不能读取或固定他处当前资料；读取期间撤权与历史引用继续按实际调用者裁决 | 远端不可达及同步失败保留有效当前资料，问答不因远端故障重拉；无有效当前资料明确提示；同步与发送并发不读半成品，断线按原输入收据恢复 |

## 第三步：工作区来源与资料维护

2026-10-23 用户要求在第二步收尾后，先完善工作区。设计维护在[仓库来源与日常资料维护](../examples/project-workbench-design.md#仓库来源与日常资料维护)，不新增另一份产品规范。模块继续称“工作区”。2026-10-24 用户批准改为当前文件与源码来源，Agent 每轮自动使用最新资料、部署独立选择 Git 提交；新规则已随 `b6e1ba4e` 完整部署到测试服务器；每轮固定输入与历史出处继续受授权及引用保护，日常页面不要求手动发布整套版本。具体成功、失败恢复和未测范围见当前发行与运行验收记录。 2026-10-24 的 `90cea0a6` 已修复 Git 更新超时导致已有源码被排除的问题，并修复手机正文与输入区重叠；上线后真实超时场景仍成功读取源码。

| 能力 | 本批实现与边界 |
| --- | --- |
| Git 来源 | 持久多来源定义，选择默认分支、分支、标签或完整提交；指定挂载目录和可选子目录；凭证只保存引用。只读获取，不推送、不运行仓库脚本，不拉取子模块/LFS |
| 日常资料 | 原件上传、同名替换/另存/跳过、目录创建、文本编辑、移动及删除；服务端修订条件与原请求收据处理冲突和未知结果。单文件 8 MiB、当前资料总量 64 MiB；无引用原件自动回收，保留活动任务输入 |
| 文档正文 | PDF/Office 复用既有 Worker；原件、摘要、解析状态与内容修订一致。历史输入继续读取原正文，异步解析返回前重查权限；进程合计最多两个文档 Worker；失败保留原件并可显式重新提取正文 |
| 每轮资料输入 | 会话绑定项目、环境、内部/外部范围与执行目标；每个新轮自动固定当前原件引用和 Git 提交。原请求、恢复与子任务保持原输入，已发送历史引用不被最新内容替代；不产生可供用户逐个选择的整套版本 |
| 服务源码包 | 部署独立选择多个 Git 来源的默认分支、分支、标签或提交，固定 SHA 与各服务上下文/构建目录，排除上传文档；ZIP、清单、取消与原部署接口继续复用 |
| UI | 复用 T3 文件浏览、设置行、菜单和 Dialog；日常为当前文件与源码来源，Git 只读，无常驻整套版本选择。旧会话的下一新轮也读取当前资料，显式旧引用仍固定；阅读位置、焦点、未知响应与撤权分别回归 |

本批复用独立后端中无身份依赖的 SQLite 基础设施，不启用独立账号或项目数据库。新资料与凭证各自拥有数据库和升级；已有工作区版本索引、任务、部署配置及会话绑定保持原所有者。发行必须包含公共 SQLite 文件、资料模块及文档 Worker，并用发行目录执行独立冒烟。

验证记录在[运行模块说明](runtime-modules.md#工作区操作简化与失败恢复2026-10-24)。当前测试发行已补齐客户电脑图片与文件输入，连接程序 0.2.0 已在本机通过真实 Codex 多模态验收，见[客户附件验收](runtime-modules.md#客户电脑图片与文件输入2026-10-24)；并包含自动对话标题默认中文（首次及重新生成），以及新旧对话使用当前技能、停用只移除对应候选、运行配置同步及重试重新读取当前分配，以及技能候选有限等待、自动续试与手动恢复，以及常用界面中文与工作台用语整理、带来源工具失败状态修复，以及顶部项目与模块导航精简、技能库直接入口，以及技能库侧栏图标与卡片层级优化、技能管理布局精简，以及此前新对话文件选择和发送后引用授权修复，实际文件分析与跨轮读取已通过，包含已确认的资料页紧凑排版、工作区一键操作、自动确认原收据及非工作区 UI 修复。资料页布局和交互的本批实证见[资料页排版验收](runtime-modules.md#工作区资料页排版2026-10-24)。两个公开 Git 来源的真实同步、外部资料生成已成功；新外部内容仍待复核发布，原已发布内容可用。发行身份、数据保留和恢复配置见[现行部署记录](../examples/agent-demo-t3-deployment.md#当前验证发行)。第二步已有证据不替代新增能力；远端私有 HTTPS 凭证仍未实测，真实写流程与只读浏览分别记录。

2026-10-25，客户电脑文件已统一到问答原生侧栏，桌面可并排查看与输入，窄屏按原生面板浏览和返回；客户读取仍使用已登记目录及有界预览。当前发行和真实交互范围见[客户文件面板验收](runtime-modules.md#客户电脑文件面板统一2026-10-25)。

## 第二步实现与验收边界

实际模块入口、唯一数据所有者及允许依赖统一见[运行模块说明](runtime-modules.md)，不再以独立后端切片的 21 项测试代替工作台回归。

- 项目能力由后端同一权限策略投影；导航、深链和操作入口消费 capabilities，HTTP、工具与后台领取仍独立校验当前授权。部署停用不影响已授权内部管理者生成和下载源码包。
- 工作区、部署、客户设备的公开 DTO 共用纯合同；前端复用同源请求边界，处理取消、超时、撤权及未知写入结果。工作区和源码包共享受控读取生命周期，任务请求用原始收据核对，禁止断网后生成新请求重复执行。
- 工作区任务有并发、排队、取消及持久化失败边界；压缩复用受限 Worker。任务使用可信操作者与进程实例，领取时重查权限，恢复同一进程号下的旧实例任务；仍按单实例写入部署，具体限制见运行模块说明。
- 部署引擎拥有配置、映射和任务事务，业务适配器通过受控公开用例协作；资料模块通过公开授权查询与宿主文件读取端口，不再读对方表或反向导入 T3 实现。
- HTTP 组合根按工作区、部署、技能、会话、资料装配；页面保留公共框架，局部渲染故障只恢复当前区域。部署日志、配置、确认流程分开维护，并区分运行版本来源与任务来源。
- 授权公开门面与内部身份、投影、策略、装配分责；T3 宿主统一停止接单、排空本地任务并按依赖顺序释放，源码与部署通过明确归档和固定接口协作。前端宿主快照、会话客户端、文件浏览和技能目录控制器分开，仍复用已有 T3 能力。
- 问答、技能、客户本机、模型及偏好继续复用原有执行与状态所有者；客户分发不包含平台存储。未实现的资源管理与机柜功能不加入本轮。

验收命令采用 `pnpm check:runtime`、`pnpm test:runtime:node`、`pnpm test:runtime:server`、`pnpm test:runtime:web`、`pnpm test:runtime:language`、`pnpm test:runtime:markdown`、`pnpm test:runtime:customer` 与 `pnpm verify:autoops`；完整串行入口为 `pnpm verify:runtime`。部署前另构建 T3 Worker，并对实际发行目录、现有数据保留、服务健康及网页进行验证。具体范围与 Linux/Windows 差异见运行模块说明。

这次是对当前已实现工作台的维护性改造，尚未把独立账号/项目后端替换进线上，也不等于已经完成原完整计划中尚未实现的功能。共享纯合同不建立两套业务存储双写。

## 规范定稿依据

第一步确定开发规则及完成标准，第二步用实际代码和测试兑现。定稿不意味着现有代码已经全部符合规范，也不要求先把所有未来页面和接口设计完。以下只索引权威规则，不复制另一套规范。

| 维度 | 已明确的规则 | 唯一维护位置 |
| --- | --- | --- |
| 范围与顺序 | 当前分支唯一基线，规范→全模块优化→新增功能；保留原计划业务内容，纠正旧顺序 | AGENTS.md、重建计划 |
| 模块边界 | 逻辑职责、唯一数据所有者、公开能力、依赖方向、组合根、跨模块事务及查询 | 后端规范“模块与唯一数据归属”“依赖与跨模块协作”；工程规范“模块说明与依赖组织” |
| 权限与安全 | 统一裁决、可信资源归属、角色与范围、私有数据、批量/下载/工具/任务、撤权与凭证使用 | 后端规范“账号、角色与资源授权” |
| 前端工程与呈现 | 当前公共框架、锁定 T3 完整呈现；模块状态、同源合同、缓存隔离、局部错误及生命周期 | T3 UI 规范；工程规范“前端代码与状态” |
| 数据与任务 | 模块表、事务、版本、幂等、持久收据、取消/未知结果和恢复、必要审计 | 后端规范“合同、数据与任务” |
| 故障与运维 | 局部故障限制、共享故障拒绝依赖操作、资源预算、升级备份、关闭及观测 | 后端规范“故障隔离与资源预算”“运行生命周期”“数据升级、配置与可运维性” |
| 复用与验证 | 优先已有/开源，禁止空抽象；测试分层、边界检查、本批回归和模块优化完成条件 | 工程规范 |
| AI 协作与文档 | 按任务读规范、区分目标/事实/历史、中文注释与提交、报告检查范围、维护唯一权威来源 | AGENTS.md、规范索引、工程规范 |

已清理现行文档中要求对照 main、按旧阶段提前补建新能力的指令；历史评估只保留为参考。规范后续允许随明确需求修订，但不因局部实现细节继续推迟全项目规范定稿。

各模块具体文件归位、完整动作入口映射、测试补齐、超时与容量参数的落实，在第二步相应模块优化时完成。它们是工程实施内容，不是必须再次询问用户的产品需求；只有无法从已确认规则推导的业务选择才提出具体问题。

## 运行条件与验证

验证基线为 Node.js **24.12.0**、根清单指定的 pnpm **11.25.0**。新代码使用 Node 原生 TypeScript 类型擦除和 `node:sqlite`；该 Node 版本会输出 SQLite 实验特性提示，升级运行时需要重跑数据库及入口测试。T3 的运行条件继续按 vendor 锁定清单核对。

从仓库根执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify:autoops
```

`verify:autoops` 与 CI 使用同一入口：Prettier → 严格 TypeScript → dependency-cruiser 完整扫描 → Node 测试。只修改格式时使用 `pnpm format:autoops`。依赖检查会因漏扫、深层导入、循环或非法依赖失败，类型导入也受检查。

此前后端批次（提交 `93f4e686`）本地验证通过 **21 项测试**：真实 HTTP 合同、独立初始化和服务入口、跨用户/项目/环境与外部范围、撤权与停用、会话恢复/注销/改密、幂等与撤权后重试、审计失败原子回滚、嵌套事务恢复、SQL 升级失败/校验值、密码计算限额及边界检查反例。扫描完整覆盖 **22 个业务源文件**。测试只用临时库和本机端口，不访问真实服务器或模型；CI 远端结果以对应提交的 Actions 状态为准。

## 首次本地启动

没有默认账号，也没有 HTTP 初始化后门。以下 PowerShell 命令选择独立数据目录，交互设置初始内部管理员；密码不写入命令文本或 Git 文件：

```powershell
$env:AUTOOPS_DATA_DIR = Join-Path (Get-Location) 'data/autoops-local'
$env:AUTOOPS_HOST = '127.0.0.1'
$env:AUTOOPS_PORT = '28900'
$env:AUTOOPS_PUBLIC_ORIGIN = 'http://127.0.0.1:28900'
$initialCredential = Get-Credential -UserName 'admin' -Message '设置新 AutoOps 初始管理员密码（12 至 128 字符）'
$env:AUTOOPS_ADMIN_USERNAME = $initialCredential.UserName
$env:AUTOOPS_ADMIN_NAME = '平台管理员'
try {
  $env:AUTOOPS_ADMIN_PASSWORD = $initialCredential.GetNetworkCredential().Password
  pnpm init:autoops
  if ($LASTEXITCODE -ne 0) { throw '管理员初始化失败' }
} finally {
  Remove-Item -LiteralPath Env:AUTOOPS_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $initialCredential = $null
}
pnpm start:autoops
```

初始化只允许空账号库运行一次。已有新产品数据只执行 `pnpm start:autoops`；不要为解决初始化冲突删除数据。旧格式数据库、未知升级版本和已修改升级会拒绝启动。

| 配置 | 默认/语义 |
| --- | --- |
| `AUTOOPS_DATA_DIR` | `data/autoops`，保存 `autoops.sqlite` 及其 WAL 文件；上例单独使用本地开发目录 |
| `AUTOOPS_HOST` | `127.0.0.1`，实际监听地址 |
| `AUTOOPS_PORT` | `28900`，整数 1–65535 |
| `AUTOOPS_PUBLIC_ORIGIN` | 对应端口的本机 HTTP 来源；必须是无路径的规范来源，外部来源必须 HTTPS |
| `AUTOOPS_ADMIN_USERNAME/NAME/PASSWORD` | 仅首次初始化使用；账号名以小写字母开头，3–64 位，允许小写字母、数字、点、下划线和连字符 |

准备远程部署时由反向代理终止 HTTPS，并将公共来源配置为真实地址。Cookie 的 Secure 属性由该来源决定；不能依靠浏览器改请求头绕过校验。数据目录权限只给运行服务的系统账号，Windows 下另外核对 ACL。

## API 使用边界

- 健康检查：`GET /health/live` 与 `GET /health/ready`；普通 API 均在 `/api/v1`。
- 登录 `POST /api/v1/login` 返回用户、CSRF 值和到期时间，并设置 HttpOnly、SameSite=Strict 会话 Cookie；刷新后用 `GET /api/v1/session` 恢复 CSRF。所有修改请求含与配置完全相同的 `Origin`；登录以外还须 Cookie 和 `X-CSRF-Token`。JSON 请求使用 `Content-Type: application/json`。
- 账号入口 `/accounts`：平台管理员创建、分页查看、停用/启用及重置密码；自己修改密码走 `/session/password`。改密、停用及注销立即使对应会话失效。
- 项目入口 `/projects`：内部成员创建项目并成为项目管理员；`/:projectId/environments`、`members`、`grants`、`capabilities`、`audit` 提供对应业务。输入字段以[合同](../autoops/contracts/index.ts)为准，方法和调用实例见 [API 回归测试](../autoops/test/foundation.test.ts)。
- 创建项目/环境带 UUID `Idempotency-Key`；同一操作者、操作和参数重试复用原结果，不同参数返回 409；每次重试仍检查当前授权。权限变化后即使 Cookie 尚未到期也不能继续原操作。
- 普通成员按环境显式授权，新环境不自动扩权；项目管理员使用项目范围。`environmentId: null` 不表示普通成员自动拥有全部环境。capabilities 只列已完成动作，不能替代服务端授权。
- 列表每页至多 100 条，按资源 ID 排序；使用响应的 `nextCursor` 作为下次 `after`，直到为 null。项目列表按授权过滤后可以出现空页，仍应继续游标。第一波未提供全文搜索、时间倒序审计或稳定快照分页。
- 错误统一为 `{error:{code,message,requestId}}`；常见状态为 400/401/403/404/409/429/500。跨项目不可访问资源返回 403，不以存在与否帮助枚举。响应与结构化日志不返回密码、令牌、SQL 或内部堆栈。

## 数据与交接

数据库使用外键、WAL、同步持久化和忙等待；业务与必要审计共用同步事务。升级账本记录顺序及 SQL 校验值，未来新增升级不能修改已应用 SQL。正式切换受影响模块前须完成该批功能回归；正式启用新平台前须验证备份恢复与目标容量，不把未来新增功能全部实现作为本轮优化前提。

开发备份采用 SQLite 一致性备份 API；也可正常停止服务，确认全部数据库连接关闭后备份整个数据目录。不要从仍在运行的服务只复制主数据库文件。恢复先验证副本与升级版本，勿覆盖正在使用的数据；数据库升级后不能假定旧程序可直接读取。

新服务处理 SIGINT/SIGTERM 时停止监听并关闭数据库；本波没有外部执行中的任务。后续添加后台任务时补停止领取、执行结果核查与恢复语义。

改动新模块使用 `verify:autoops`；旧 `pnpm check` 主要覆盖旧脚本与 `web`，不证明新产品或 T3 全部通过。改动 UI 时另做 T3 类型/构建与实际交互验收，改动公共执行模块同时验平台和客户宿主。交接报告具体命令、结果和未测边界，常规开发不触发真实发布或设备操作。
