# main 部署核心适配方案与实施记录

调查日期：2026-10-25。main 固定提交：`38e20cfc417d16585965f158e0be584b6f046143`；实施前功能基线：`7aea2bb65cb231afe881999b5f6d50f09f6d5baa`，分支 `feat/workspace-deployment-validation`。

本方案基于固定提交的 Git 对象、实际代码、公开合同和测试定义。2026-10-25 用户已确认按四批推进实现，并明确要求彻底删除旧 Jenkins／脚本直取源码功能。本次迁移按下列公开合同适配，不合并整条 main 分支。第 1—9 节保留实施前调查及已确认范围，其中“当前”“待补”均对应上述调查基线，不表示实施后的状态；本批实际实现及验证进度见第 10 节。代码存在、模拟测试通过与真实发布通过分别记录。

## 1. 实施前调查结论

调查时部署核心已经在工作分支中。main 是调查基线的祖先；main 的 `agent/` 共 22 个文件与调查基线逐一 blob 相同，`src/` 的 11 个文件全部存在，其中 8 个相同，只有 `deployment.mjs`、`service.mjs`、`source-archives.mjs` 被工作分支扩展。main 原有 `test/` 15 个文件全部保留，14 个相同，[deployment.test.mjs](../test/deployment.test.mjs) 增加了回归。

调查时的缺口是 AutoOps 公共合同、项目/环境映射、HTTP 与 T3 页面只接通了前端静态站点发布的一部分能力。当时 [createDeploymentStore.createTask](../agent-demo/t3-adapters/deployments.mjs) 限制 `action = deploy | rollback`、`service = frontend`；[createProjectDeployments.createTarget](../src/deployment-projects.mjs) 固定建立 static 服务；部署 HTTP 只注册概览、创建服务器、创建目标、提交任务、任务详情和版本列表六类路由。这些是本批实施的起点，不再作为实施后的缺口结论。

因此应实施“补齐当前业务适配与 T3 入口”，继续使用当前已优化的同一个部署引擎与 Agent。不能通过合并旧 UI、重启旧中心、复制一份执行器来完成；也不能恢复 main 中被当前分支消除的内部锁穿透和 builder 方法改写。

## 2. main 实际产品与部署边界

main 的中心是[单管理员部署平台](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/server.mjs#L41)，前端是[React/Radix/Solid Glass 控制台](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/App.jsx#L92)。它的“工作空间”指项目、环境、仓库、服务和服务器集合，不等于当前 AutoOps 的“当前资料/Agent 输入”。main 并无 T3 问答、项目细粒度角色、客户电脑 Codex 执行模型。

main 的实际部署类型只有两类：

- **Java/Maven 服务**：根 Maven 工程或指定模块，构建 JAR，再构建运行镜像，通过 Docker Compose 更新目标容器，验证容器健康。支持重启、自动失败恢复和手动历史回退。
- **前端静态站点**：npm/pnpm 锁定安装，执行 package.json 指定构建脚本，固定产物目录，原子切换站点 `current` 指针；现有 Nginx 始终运行。验证站点 HTTP 200、发行标识及可选正文。支持自动恢复与手动回退，明确不支持重启共用 Nginx。

main 没有实现：通用 Dockerfile/任意容器项目部署、Node SSR 常驻服务、Python/Go 运行服务、Kubernetes、蓝绿/金丝雀、多服务原子编排、任意远端 Shell、接管 Jenkins 容器、数据库升级/恢复、任务取消或强制杀部署、审批流。不能把这些写成“迁移既有能力”。

## 3. 完整能力清单及实施前适配差距

| #   | main 已实现的能力                                                                                                                     | 代码证据（main 固定提交）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 实施前 AutoOps 状态与已确认适配要求                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 项目创建/编辑，默认测试与生产环境；环境创建、改名、无引用时删除                                                                       | [项目创建与环境删除](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspaces.mjs#L154)；[实体保存](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L297)；[环境页](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/service-pages.jsx#L470)                                                                                                                                                                                                                                                                                                                                                                                                                                             | 当前项目/环境属于现有 access/catalog；引擎已用 [src/deployment-projects.mjs](../src/deployment-projects.mjs) 持久映射。必须复用真实项目/环境归属，不再复制 main 的项目主数据或默认环境创建逻辑                                    |
| 2   | 服务独立于部署位置；Java/static 服务、模块目录；同服务可在多环境、多服务器有多个部署位置                                              | [服务及目标规则](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L297)；[服务列表](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/service-pages.jsx#L116)；[部署位置表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/target-form.jsx#L20)                                                                                                                                                                                                                                                                                                                                                                                                                            | 当前每次“添加前端服务”同时创建一个 service 和一个 target，没有独立服务目录及多目标配置流程。补齐服务主记录、每环境配置与部署位置；已有 target/service ID 保持不变                                                                 |
| 3   | 项目仓库登记/编辑/停启；默认分支识别与刷新；连接失败保留记录                                                                          | [仓库保存](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/service.mjs#L145)；[分支读取](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/archive.mjs#L72)；[仓库表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/dialogs.jsx#L141)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 当前工作区已有多来源、默认/分支/标签/提交选择，并支持获准 HTTPS 来源。沿用该来源模块，不能恢复 main 的 Gitee-only 限制或再建一份仓库配置                                                                                          |
| 4   | 环境 × 服务关联仓库；发布时可选其他分支及具体提交；已运行分支为合理默认；刷新最近 100 条提交                                          | [服务来源选择](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspaces.mjs#L140)；[环境服务来源绑定](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspaces.mjs#L169)；[提交历史](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/archive.mjs#L103)；[发布分支选择](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/release-workbench.jsx#L725)                                                                                                                                                                                                                                                                                          | 当前独立部署包已可选择多仓默认/分支/标签/SHA，但没有服务级默认来源配置及 main 的分支/提交选择体验。补服务来源关联与可选提交列表，提交任务时固定 SHA，不能改日常资料跟踪配置                                                       |
| 5   | Git 凭证加密保存、替换、删除引用保护；不返回明文                                                                                      | [凭证保存与删除](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/service.mjs#L109)；[秘密解析](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/service.mjs#L211)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 当前 [credentials.ts](../agent-demo/t3-adapters/credentials.ts) 已有项目凭证、版本引用、撤销检查、use/manage 区分，能力更符合新边界。复用当前凭证模块，不复制 main 全局凭证页和全局管理员权限                                     |
| 6   | 旧 Jenkins/浏览器源码分发：独立下载口令、重置、停用即时拒绝；每次下载检查远端并返回完整 ZIP/SHA                                       | [机器下载入口](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/server.mjs#L117)；[下载口令轮换](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/service.mjs#L185)；[下载授权](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/service.mjs#L204)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 用户已明确排除并要求删除：旧 latest 下载路由、独立下载口令、轮换/校验/计数、浏览器下载页及 Jenkins 示例。以版本化迁移移除专属持久字段；保留 Git 凭证、工作台固定包、历史档案和部署 Agent 任务取包                                                                            |
| 7   | 新服务器一次性注册令牌，15 分钟过期、单次使用；安装命令、安装脚本和 Agent 包；持久身份                                                | [服务器创建](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L206)；[注册](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L239)；[安装资源](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/install-http.mjs#L4)；[安装脚本](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/install.sh#L1)；[身份恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/runner.mjs#L21)                                                                                                                                                                                            | 当前有创建服务器 API，并返回一次性令牌；T3 客户端无对应管理函数/页面，返回还裁掉了 installCommand。接入专用部署服务器 UI、HTTPS 安装资源路由、注册结果核对需要补齐；不得复用“我的电脑”配对身份                                    |
| 8   | 已有服务器绑定多个项目、项目内解绑；全局撤销接入；只有无目标/任务/历史才允许删除撤销记录                                              | [项目服务器绑定](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspaces.mjs#L155)；[撤销及删除](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L219)；[服务器页](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/pages.jsx#L315)；[绑定表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/dialogs.jsx#L265)                                                                                                                                                                                                                                                                                               | 当前 map.servers 只记录创建服务器时的项目/环境，没有公开 bind/unbind/revoke/delete 适配。需支持一个部署节点的显式项目/环境绑定，解绑不能清目标/历史；撤销影响多个项目须呈现范围并授权                                             |
| 9   | 主机 CPU/内存/磁盘/中心 RTT、Agent 版本/能力、在线/失联；仅采集平台目标运行与健康                                                     | [主机与目标观测](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/monitor.mjs#L8)；[心跳](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/runner.mjs#L52)；[中心观测更新](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L270)；[服务器页](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/pages.jsx#L315)                                                                                                                                                                                                                                                                                                                   | 现引擎仍收集这些数据；`safeServer` 仅输出名称、在线、版本、能力，未输出 metrics/containers/storageStatus；目标 observation 被适配 DTO 选择，但 TS 合同/运行状态展示未完整接入。补可信观测时间与过期状态，不能把历史成功当实时健康 |
| 10  | 新增/编辑目标；环境、服务、服务器归属固定；可复用同服务已有配置模板；活动任务期间限制修改目标                                         | [目标校验与保存](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L297)；[目标配置及模板](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/target-form.jsx#L20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 当前只可新增静态目标、查看配置，没有更新目标接口/UI。补编辑与版本条件校验、配置模板；任务仍使用创建时配置，切页面或后续保存不能改变已接受任务                                                                                     |
| 11  | Java 构建配置：Maven 模块、唯一 JAR 路径、构建/运行镜像、JVM/应用参数、Profile、构建与运行 CPU/内存                                   | [配置校验](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L62)；[Maven构建](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L186)；[构建表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/target-form.jsx#L250)；[运行表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/target-form.jsx#L348)                                                                                                                                                                                                                                                                                             | 底层能力完全存在；当前合同只有 StaticDeploymentConfig，UI 只有“添加前端服务”。补可判别 java/static 合同及 Java 配置，后端源码 ZIP 已支持生成；已有 `createTaskFromArchive` Java 测试证明不需旧仓库关联                            |
| 12  | Java 网络/端口/平台命名卷、固定 Docker 网络别名；冲突/归属检查；别名随重启/历史回退保留                                               | [网络身份](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/config.mjs#L35)；[Compose与资源配置](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L15)；[资源预检](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L55)；[目标规则](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L297)                                                                                                                                                                                                                                                                                                                         | 当前目标创建硬编码 networkIdentity:null，未暴露。补到 Java 部署位置高级配置；已有外部 Docker 网络可以引用，不能让用户挂任意宿主路径或接管非平台容器                                                                               |
| 13  | 静态构建 npm/pnpm 精确版本、锁文件、构建脚本/参数、产物路径、构建限额；独立 Nginx 接入前置条件                                        | [锁定前端构建](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/static-build.mjs#L1)；[静态预检与构建](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/static-deployment.mjs#L37)；[目标表单](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/target-form.jsx#L250)                                                                                                                                                                                                                                                                                                                                                                                                                                   | 当前静态任务已接通此执行器及配置；需补可维护的目标编辑、接入检查与错误定位。Nginx 挂载/站点配置当前仍由运维准备；不要声称 main 已自动配置 Nginx/TLS                                                                               |
| 14  | 固定源码包、配置、提交说明、源校验值；重复 requestId 去重、参数冲突拒绝、配置变更拒绝；完整 ZIP 校验交付                              | [任务创建](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L369)；[源码准备](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L449)；[包传输](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/client.mjs#L1)；[中心档案校验](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/source-archives.mjs#L33)                                                                                                                                                                                                                                                                                                                           | 当前 `createTaskFromArchive` 已强化 sourceIdentity/actor/归档校验；多仓/服务上下文排除上传资料。继续保留，Java 补同一入口。不能回退到 main “发布前直接从旧仓库库拉取”的入口                                                       |
| 15  | 同一服务器跨项目串行，准备源码占队列位置；不同节点独立领取；长轮询只被本节点可领取任务唤醒                                            | [领取与长轮询](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L491)；[单节点执行](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/runner.mjs#L84)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 当前已共享，并额外在领取时重查操作者权限。保留同服务器互斥，不引入第二套通用队列；补新服务/跨环境用例                                                                                                                             |
| 16  | Java 发布与健康校验；静态原子切换、发行标记及正文校验；编译失败不改变当前服务；首次发布失败清本任务产物                               | [Java切换与健康](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L222)；[Java执行](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L279)；[静态切换与健康](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/static-deployment.mjs#L91)                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 静态发布入口已接通；Java 新工作台未接通。两类均需要通过新入口真实验收，不能以同一执行器存在或单测通过宣称业务发布完成                                                                                                             |
| 17  | Java 重启当前已成功版本并检查健康；不拉 Git、不编译、不应用“下次发布”配置；静态明确禁止重启 Nginx                                     | [Java重启](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L72)；[任务动作校验](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L369)；[重启入口](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/release-workbench.jsx#L821)                                                                                                                                                                                                                                                                                                                                                                                                                                              | 当前 adapter/合同/UI 都拒绝 restart。补 Java 重启动作和后果确认；不能使用重新发布代替重启                                                                                                                                         |
| 18  | 自动失败恢复与手动回退；本地产物命中恢复，缺失则原中心源码＋历史配置＋已固定镜像摘要重建；切换前保护当前恢复基线                      | [缓存或源码恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L144)；[基线保护](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L165)；[Java失败恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L256)；[静态失败恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/static-deployment.mjs#L116)；[中心结果处理](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L555)                                                                                                                                                        | 当前静态回退已接通，Java待接；必须分别显示发布失败但恢复成功、恢复失败、首次无基线、尚未核实。回退产生新成功节点，重启不新增发布节点；保留当前分支更准确的 runtimeStatus 推导                                                     |
| 19  | 发布阶段/耗时、每序号持久日志、离线补报/去重、发生时间与接收时间；流程图、阶段筛选、搜索、复制、下载                                  | [事件与日志持久化](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L555)；[日志补读](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L645)；[本地任务日志](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/state.mjs#L20)；[阶段展示](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/release-workbench.jsx#L1320)；[日志工作台](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/release-workbench.jsx#L1471)                                                                                                                           | 当前日志补读、终态、阅读位置已有；缺 main 的日志搜索/复制/下载与按阶段筛选，阶段中文硬编码前端含义（building=构建前端）。补 Java含义、日志工具；按项目环境授权、下载不泄露其他服务日志                                            |
| 20  | 成功版本分页/按ID直达、来源与历史配置/构建摘要；下载/清理历史源码；当前版本、恢复基线、活动引用不可清理                               | [版本分页](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L651)；[版本及源码HTTP](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspace-http.mjs#L63)；[档案保护与清理](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/source-archives.mjs#L121)；[版本操作UI](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/release-workbench.jsx#L425)                                                                                                                                                                                                                                                                                 | 当前版本列表和回退可用，返回全部版本，缺分页/历史直达/版本档案下载与清理适配。工作区源码包下载不能替代引擎持久历史档案。补公开 archive 操作与授权/引用保护，显示清理后不可重建                                                    |
| 21  | 节点存储策略：保留 2–20 成功节点、专用 BuildKit缓存 1–20 GiB；空闲执行、回报revision/失败/用量；成功档案中心永久保留、失败档案7天清理 | [存储参数](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/storage-policy.mjs#L1)；[专用构建缓存](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/build-cache.mjs#L5)；[空闲维护](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/runner.mjs#L105)；[中心策略保存](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L258)；[策略UI](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/web/src/components/storage-policy.jsx#L28)；[中心失败档案清理](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/source-archives.mjs#L148) | 引擎/Agent已支持，T3无入口且 safeServer裁掉报告。补节点级策略配置与执行结果；不可把“策略已保存”显示成“清理已完成”，不使用全局docker prune                                                                                         |
| 22  | 中心停服拒新/结束SSE/排空源码准备；中心重启保留执行任务；Agent离线继续已领取动作、本地事件补报；Agent重启按阶段核查不重复部署         | [中心关闭](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/server.mjs#L191)；[部署关闭](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L656)；[Agent补报与恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/runner.mjs#L63)；[Java恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/executor.mjs#L315)；[静态恢复](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/static-deployment.mjs#L157)                                                                                                                                                                          | 当前宿主生命周期已更强、已共享Agent。必须保留现有停服/未知结果处理；新增接口纳入同一 lifecycle，不把远端任务标成“因页面关闭已取消”                                                                                                |
| 23  | 本地任务、成功链、配置、身份、中心归档及日志持久化；旧格式迁移先备份，损坏/密钥丢失拒启动                                             | [中心持久化](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/store.mjs#L13)；[工作空间迁移](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspaces.mjs#L25)；[档案迁移](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/source-archives.mjs#L72)；[Agent持久收据](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/agent/state.mjs#L20)                                                                                                                                                                                                                                                                                                                         | 当前正使用同一引擎持久格式，继续由引擎拥有。扩展映射须版本化并保留现有服务、历史、当前指针、原请求；不启用独立autoops后端空库，不复制main的历史业务数据或旧服务目录                                                               |

## 4. API 和授权核对

### main 接口

入口证据：[项目路由](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/workspace-http.mjs#L6)、[部署与 Agent 路由](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deploy-http.mjs#L6)、[登录、凭证及下载](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/server.mjs#L41)、[安装资源](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/install-http.mjs#L4)。

- 浏览器项目操作：`/api/workspaces/:applicationId` 下 `servers`、`environment-sources`、`repositories/:id/branches[/refresh]`、仓库CRUD/同步/口令轮换/停启、`environments`、`services`、`targets`、`tasks`、`targets/:id/source[/refresh]`、版本分页/详情、`releases/:id/source` 下载或清理、项目SSE。
- 全局部署操作：`/api/deploy/overview`、服务器创建/存储策略/撤销/删除、applications/environments/services/targets保存、任务创建/详情、版本列表、全局SSE。
- 机器协议：`/api/agent/v1/register`、`heartbeat`、`claim`、`tasks/:id/events`、`tasks/:id/source` GET/HEAD（selected/baseline）；注册一次性令牌，之后专属Bearer凭据，按server与target归属校验。
- 下载兼容：`/api/projects/:id/source/latest` Bearer下载；`/download/:id` 浏览器下载页；`/agent/install.sh`、`/agent/bundle.tar.gz` 安装资源。

main 用户端是[单管理员会话＋CSRF](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/server.mjs#L107)，项目路由校验资源所属，但没有现有 AutoOps 的成员、内部/外部范围及环境动作授权。因此“全量适配”是功能覆盖，不是照搬这些端点和权限。不能把旧 `/api/deploy/overview` 全局结果直接返回给项目成员。

### 实施前已接通的入口

调查时 [vendor/t3code/apps/server/src/autoops/http/deployments.ts](../vendor/t3code/apps/server/src/autoops/http/deployments.ts) 的 6 类路由调用 [agent-demo/t3-adapters/deployment-http.mjs](../agent-demo/t3-adapters/deployment-http.mjs)；其入口要求项目内部 manager，并检查授权环境。`createDeploymentStore` 通过引擎公开 `projects` 用例完成映射，提交/领取保存并重查可信 actor。前端 capabilities 仅控制可见与可点，服务端仍裁决。

迁移必须明确动作权限：查看目标/日志/历史、配置服务与位置、接入/绑定节点、发布、重启、回退、管理存储、下载与清理档案。当前运行权限仍粗粒度 manager；独立 `autoops/server` 的角色模型尚未接入。建议先在现有权威授权入口明确动作合同并保留当前有权用户，再按用户确认的角色范围扩展，不在部署适配器自建一套身份。新增公开API遵循现行命名规范并集中装配；既有入口若改名须同步全部调用方，不保留两套业务写实现。

## 5. 已确认适配设计

### 5.1 对象、配置与数据归属

配置模型先确定“配置给谁、影响哪次执行”，再接表单。确认采用下列模型；这部分是阶段 A 的实际交付内容，不是仅增加 TypeScript 字段。

| 对象                     | 唯一所有者与主要内容                                                                                     | 关系和变更生效规则                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目、环境               | 现有项目/环境模块；名称、稳定 ID、可访问范围                                                             | 部署引用当前 ID，并保留引擎 UUID 映射。环境删除继续检查目标、任务和历史引用，不另建项目主数据                                                                         |
| 服务                     | 部署引擎；名称、`java/static` 类型、构建模块/上下文                                                      | 服务属于一个项目，可在多个环境和服务器有多个部署位置。已有静态 service/target ID 保留；不会把同名服务自动合并。构建上下文修改只影响后续发布，须检查已关联配置是否兼容 |
| 服务来源配置             | 部署公开用例维护“服务 × 环境”的来源引用和默认分支/标签/提交选择；实际仓库及凭证仍由现有来源/凭证模块拥有 | 同服务同环境的多个位置复用默认来源，单次发布可以显式选择其他固定提交。保存发布来源不能修改日常工作区跟踪配置或 Agent 当轮输入                                         |
| 部署位置                 | 部署引擎；服务 × 环境 × 服务器、构建与运行配置、固定网络身份                                             | 同一个服务可有多个位置。创建后归属不随编辑重定向；迁往另一服务器应建明确的新位置。构建参数和运行参数按类型保存，活动任务期间沿用引擎修改限制；保存配置只用于后续发布  |
| 部署服务器及绑定         | 部署引擎持有专用 Agent 身份、能力、存储策略；适配映射持有显式项目/环境绑定                               | 一次接入可授权给多个项目/环境；与“我的电脑”身份独立。绑定、解绑、撤销走引擎公开用例，不能直接写集合。共享节点的全局动作显示受影响范围                                 |
| 来源、凭证、固定包       | 来源/凭证模块负责配置、版本引用和撤销；固定部署包按现有工作区公开合同生成                                | 只包含实际源码与构建所需上下文，不加入上传资料。捕获时固定 SHA、目录、清单和校验值；不复制一份 Gitee 仓库库或凭证                                                     |
| 任务、发布记录、历史档案 | `DeploymentService` / `SourceArchives` / Agent 各自拥有中心任务、中心档案及本地恢复链                    | 接受任务时冻结服务类型、来源身份、配置、目标和可信操作者。后续页面切换、来源更新或配置保存均不能改变该任务；T3 不另造状态机                                           |
| 当前运行信息             | 引擎确认的发布指针与 Agent 观测分别持有版本事实、观测事实                                                | 保存“下次发布配置”不改变“当前运行配置”。重启只使用当前成功版本；回退使用历史配置和固定档案；观测过期不能显示实时健康                                                  |

Java 配置包含 Maven 模块/JAR、构建镜像、运行镜像、JVM/应用参数、Profile、CPU/内存、端口、网络、平台命名卷和健康检查。静态配置包含构建目录、npm/pnpm 精确版本、锁文件、脚本、产物目录、构建限额和 HTTP 健康检查。字段由当前引擎验证，公共合同使用 `kind` 可判别结构，不把 Java 字段塞进静态配置或放开任意命令。

调查时底层 Java 执行器及[固定工作区包进入 Java 引擎的测试](../test/deployment-workspace-source.test.mjs)已经存在；当时待补的是上述配置/来源关系、公开用例、授权、HTTP 与 T3 交互。本批接通情况见第 10 节，真实 Java 发布须另有隔离目标验收证据。阶段 A 不重新搬运或改写 Java 执行器。

存量升级必须在引擎所属存储内版本化完成：已有服务、目标、节点、绑定、请求标识、历史档案与当前指针保持身份；可重复运行且失败不留下半个映射。新表单不能靠重新创建原目标实现兼容。当前项目授权、部署引擎与工作区来源之间只通过公开合同协作，不直接改对方表、锁、缓存或 builder。

### 5.2 用户入口

沿用当前锁定 T3 的公共顶栏和项目选择。部署模块侧栏以服务为主，在同一服务下选择环境和部署位置。主区突出当前版本/当前健康观测及“发布”主动作，日志、发布记录、配置按原生面板/页签展开。

- 服务/位置配置使用原生Dialog/Sheet或Settings分组；按Java/static只展示相关字段，高级资源/网络参数按需展开。可复制已有位置配置，但创建时显式选择目标归属。
- 常规发布流程建议：选服务/位置 → 发布 → 选择分支/标签/提交（默认已配置来源）→ 核对目标与版本 → 确认。系统内部固定源码包和配置后进入任务。保留“源码包”独立下载/复用入口，不强制用户每次先去另一页手工生成，再回来找包。
- 已生成固定包可以作为明确来源选项，但需显示实际服务/构建目录与提交；旧包不能悄悄替换成当前源码。多服务使用同一仓库时各选自己的构建上下文，共享依赖包含在包内。
- Java“重启”和“回退”、历史档案下载/清理、节点存储策略放在对应对象的次级操作。常用日志检索/复制/下载直接放日志工具栏。
- 来源原理、内部请求标识、数据库映射不默认展示给用户。异步收据自动核对，未知结果准确显示“正在确认结果”，保留一次可操作的重试/详情，不能一律假报失败或重新生成requestId执行。

上述为已确认的实施目标，不能据此宣称新发布动作已验证。操作次数须在相同起点、已配置目标和相同发布源条件下比较；此示意流程不作为实测点击次数，实际前后步骤及测试入口统一记录在[运行与验证记录](../docs/runtime-modules.md#main-部署核心适配2026-10-25)。

### 5.3 实施前待补的界面与公开 API 清单

下表保留调查时确认需要补齐或扩展的公开用例语义，实际实现见第 10 节。实施沿用现行路由/命名规范，集中装配 HTTP 与授权；每类写入均复用持久请求标识、参数冲突检查和结果核对。

| 功能组                   | T3 界面补齐                                                   | 公开 API/合同补齐与边界                                                                                                                  |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 服务目录与环境来源       | 独立服务列表、服务新增/编辑、环境来源配置                     | 项目内服务查询/创建/修改；服务 × 环境来源读取/保存；引用现有仓库/凭证与构建上下文，校验类型和归属                                        |
| 部署位置与配置           | 同服务多个位置；Java/static 配置表单；编辑与复制已有配置      | 按服务/环境查询位置、创建/修改配置、读取可复用模板；保留配置条件校验与活动任务保护；归属不可被编辑重定向                                 |
| 发布来源选择             | 发布弹窗内选择默认/分支/标签/提交，展示提交说明及固定包       | 通过来源公开接口读取提交/分支，按服务上下文捕获部署包；复用既有生成/下载合同；不能创建第二套 Git 缓存或向前端返回凭证明文                |
| Java 发布与重启          | 发布、当前版本重启、失败恢复和手动回退                        | 扩展现有任务合同和提交用例至 Java 与 restart；原任务详情继续使用同一事件/收据；领取时重查当前授权                                        |
| 服务器接入               | 注册、复制安装命令、接入状态和失败信息                        | 一次性注册创建/结果读取，HTTPS 安装资源；保留现有 Agent 注册/心跳/领取协议；不复用客户电脑配对                                           |
| 服务器绑定与退出         | 绑定/解绑项目环境、共享影响范围、撤销接入、符合条件后删除记录 | 节点范围查询、bind/unbind/revoke/delete 公开用例；全局动作单独授权，引用保护不可绕过；撤销不声称已杀掉远端在途任务                       |
| 运行观测                 | 主机 CPU/内存/磁盘/RTT、能力、最后观测时间；目标运行/健康     | 扩展安全服务器与目标 DTO，包含可信时间、过期/未知状态和授权范围；不返回其他项目的容器详情                                                |
| 节点存储                 | 保留数量/缓存预算设置，执行进度、用量与失败详情               | 存储策略读取/保存和 Agent 回报查询；保存成功与执行成功分开；仅使用专用缓存和平台资源清理                                                 |
| 历史与源码档案           | 历史分页、按版本直达、下载固定档案、受保护的清理              | 分页查询、按 ID 详情、档案下载/清理；使用 `SourceArchives` 公开方法及引用保护；不能用当前工作区包替代历史档案                            |
| 日志操作                 | 既有增量日志之上增加阶段筛选、搜索、复制、下载                | 保留增量游标与序号；为完整下载/超出已加载区间的搜索明确服务端范围和上限，不能将本页已加载日志冒充全量                                    |
| 动作权限与结果恢复       | 按权限显示操作；准确保留等待/失败/恢复反馈                    | 在现有权威授权入口明确查看、配置、接入、发布、重启、回退、存储与档案动作；扩展接口共用宿主 lifecycle，不引入独立身份或任务状态机         |
| 旧机器源码下载退役 | 删除旧下载页、下载口令及相关菜单、表单和 Jenkins 示例 | 删除专属路由与公开方法，版本化清理旧下载字段；固定包、历史档案、Agent 任务源码及 Git 凭证保持有效 |

### 5.4 已确认的四个批次

| 批次                       | 实际范围                                                                                                                                                           | 完成门槛                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：配置模型与存量保护      | 先交付 5.1 的服务/环境来源/部署位置关系及 Java/static 配置合同；明确未来配置与当前运行快照；扩展引擎公开用例、项目映射、动作权限和节点多范围绑定；实现存量兼容升级 | 已有静态服务/目标 ID、源码包、历史、收据、当前指针不变；旧静态回归通过；新增来源/服务/目标归属、撤权、幂等和升级失败/重复执行用例；不重建已有目标、不复制引擎 |
| B：Java 与静态完整发布主链 | 服务/位置配置、来源关联、提交选择、包捕获、发布、Java 重启、健康检查、失败恢复和手动回退；前端静态复用同一操作框架                                                 | 通过新入口实测隔离 Maven 多模块与 Java 容器；静态站点同样验收；失败保护、回退、重启不重建、固定网络别名有证据；无关服务保持原版本                             |
| C：管理闭环与旧功能退役      | 完成 5.3 中服务器接入/绑定/解绑/撤销、配置编辑/模板、主机观测、版本分页/档案下载清理、存储策略、日志搜索复制下载；彻底删除旧机器直取源码能力                       | 每类动作有越权/引用保护；旧 Agent 能力明确；清理核对真实回执；跨项目共享节点队列及失败隔离通过；浅深色/窄屏/短窗口/焦点/长日志交互有记录                      |
| D：恢复与发行验收          | 断网、中心重启、Agent 构建中与切换后重启、补日志、程序升级和恢复预检；隔离目标真实发布验收                                                                         | 原收据不重复执行；编译中断与切换后核查准确区分；备份校验、程序回滚保持发布后新数据；对应 CI 与真实发行版本一致；23 项逐项闭环或附用户明确排除决定             |

用户已确认全部核心能力分四批交付，并明确删除第 3 节第 6 项旧机器源码下载。批次用于控制影响和逐批验收，23 项调查清单保留作为范围依据。工程上只有一套部署引擎和各自唯一的数据所有者，不迁入旧 UI、旧账号和旧历史数据。

## 6. 不应从 main 复制的设计

- `web/src` 的 Radix/Solid Glass 页面壳、卡片/长表单和说明文案：仅作为业务入口证据，呈现全部使用当前锁定T3。
- 单管理员登录、旧浏览器账号初始化入口、全局项目数据、全局凭证用法：继续当前真实账号和项目/环境授权。
- main [DeploymentService.initialize](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/src/deployment.mjs#L139) 对注入 `repository.builder.build/history` 的方法改写：当前已用 `captureArchive/pinRevision/releasePin/cachedCommitSubject/waitForIdle` 公开协作替代，不能退回。
- main 的 Gitee-only 来源限制、旧仓库配置存储与按默认分支下载的直接入口：采用当前多仓来源与独立部署输入；保留“发布固定提交、Agent默认当前资料”的产品规则。
- 直接复制main `state.sqlite` 或旧发行备份到当前业务目录：禁止。代码已有，功能适配并不需要迁入旧业务数据；若另有main实际业务历史迁移需要，须独立指定数据源与映射。
- 为迁移能力顺手重构整个旧Store或更换数据库：当前引擎格式继续由引擎拥有，先做兼容且有测试的增量扩展；不借功能迁移提前切独立后端。
- 将主机在线、历史成功、实时健康混成一个绿色“正常”；把发布失败恢复成功标成发布成功；或把取消弹窗当任务取消。

## 7. 实施前测试入口与已确认验收要求

调查阶段只核对了测试代码，没有运行下列套件。下表保留当时已有测试入口和确认需要补充的证据，不作为本批执行结果；本批测试进度见第 10 节，最终结果统一记录在[运行与验证记录](../docs/runtime-modules.md#main-部署核心适配2026-10-25)，真实发布另见[当前验证发行](agent-demo-t3-deployment.md#当前验证发行)。

| 层次/入口                                                                                                                                                                 | 调查时已有的代表性覆盖                                                                                                                           | 已确认需要补充的证据                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [test/deployment.test.mjs](../test/deployment.test.mjs)                                                                                                                   | 档案保护/去重、重建不读当前仓库、服务器注册/撤销、源码固定、同机串行、日志补报时钟、失败回退、固定网络别名                                   | 新T3入口也触发相同能力，角色/环境权限完整覆盖                                                            |
| [test/agent.test.mjs](../test/agent.test.mjs)                                                                                                                             | Java/static 发布、重启、自动/手动恢复、归属拒绝、镜像检查、ZIP穿越/CRC/解压炸弹、缓存/链条/存储策略                                          | 保留；按新增配置/网络语义补回归。文件含 FakeDocker/mock，不能算真实Docker                                |
| [test/workspaces.test.mjs](../test/workspaces.test.mjs)                                                                                                                   | 多仓/多服务、分支提交、跨项目归属、共享节点串行、历史分页直达、环境删除引用保护                                                              | 重写调用路径为现行来源合同，不回灌main工作空间模型                                                       |
| [test/deployment-lifecycle.test.mjs](../test/deployment-lifecycle.test.mjs)                                                                                               | SSE撤销、关闭排空、准备任务停止超时、停止期间拒绝领取                                                                                        | 新API订阅/后台维护纳入实际T3宿主，实际关闭行为可核对                                                     |
| [test/integration-protocol.test.mjs](../test/integration-protocol.test.mjs)                                                                                               | 真实HTTP中心/Agent断线重连、去重、归属                                                                                                       | 该文件 Docker由 ProtocolDocker模拟；可证明HTTP协议，不证明真实编译/容器运行                              |
| [test/source-cache.test.mjs](../test/source-cache.test.mjs)、[build-cache.test.mjs](../test/build-cache.test.mjs)、[static-build.test.mjs](../test/static-build.test.mjs) | 完整ZIP缓存授权、损坏重下/大小/隔离、精确缓存字节与连接失败、锁定依赖参数                                                                    | 当前主门禁已包含；新增预算不放宽原边界                                                                   |
| [test/deployment-workspace-source.test.mjs](../test/deployment-workspace-source.test.mjs)                                                                                 | Java固定工作区包可进入原队列、不需旧环境源码仓库；另有包校验/actor幂等/历史回退身份                                                          | 这是引擎级Java能力证据，尚不是AutoOps Java端到端入口                                                     |
| [test/t3-deployments.test.mjs](../test/t3-deployments.test.mjs)                                                                                                           | 现行静态适配、项目环境映射、撤权后领取拒绝、包交付、幂等、跨范围、宿主关闭                                                                   | 增加java、restart、编辑、bind/revoke/storage/archive/query每类真实HTTP授权/失败路径                      |
| [test/source-cooperation.test.mjs](../test/source-cooperation.test.mjs)                                                                                                   | 冻结builder不改写、共享锁/归档消费、失败隔离与排空                                                                                           | 必须保持；不能迁移main代码后使其退化                                                                     |
| `vendor/t3code/apps/web/src/autoops/deployment/*.test.*`、`DeploymentAccess.browser.test.tsx`、`deployments.test.ts`                                                      | 表单、配置/上下文、未知提交、撤权、日志/运行版本状态                                                                                         | Java表单/动作、核心步骤对比、失败/恢复反馈、焦点/键盘、短窗/390px、长名称与日志                          |
| [test/deploy-browser-smoke.mjs](https://github.com/coco-ari/CodeMinificationRepository/blob/38e20cfc417d16585965f158e0be584b6f046143/test/deploy-browser-smoke.mjs#L1)    | main控制台发布/回退/日志/导航                                                                                                                | 旧UI模拟验收只提取业务场景，不部署旧UI；改写T3流程                                                       |
| [test/docker-integration.mjs](../test/docker-integration.mjs)                                                                                                             | 隔离真实Docker：Maven发布、重启、自动/手动回退、编译失败、中心/Agent重启、跨项目共享服务器、固定别名、static/Nginx、旧产物重建、专用缓存额度 | 按当前业务入口适配后串行执行；需要隔离Linux Docker和网络。只清本次资源，不能在共享服务器直接整套重型回归 |
| [test/t3-deployments-live.mjs](../test/t3-deployments-live.mjs)                                                                                                           | 当前静态真实prepare/verify/failure及授权核对流程                                                                                             | 扩充Java与节点管理，提供专用测试应用、端口、网络、卷与明确健康目标；不要在用户线上现有服务故障注入       |

当前 `pnpm test:runtime:node` 的命令定义覆盖 `test/**/*.test.mjs`，原 main 多数逻辑回归仍纳入门禁配置。`verify:runtime` 并不自动等于 `test:docker` 或所有手工live脚本已执行。相关检查选择按影响范围执行，CI、模拟HTTP、浏览器操作、真实构建/发布分别报告。

## 8. 已确认的业务选择与验收前提

2026-10-25 用户确认按建议推进四批适配，并明确“不保留旧 Jenkins／脚本下载源码，彻底删除”。

1. **完整范围**：按第 3 节清单实施，明确排除并删除第 6 项旧机器源码下载。旧单管理员、旧页面和历史数据不迁入；原有固定包与 Agent 任务源码能力保留。
2. **服务器共享管理**：节点一次登记，按项目/环境显式绑定；平台管理员控制跨项目接入授权、全局撤销和存储策略，项目管理员管理已授权范围的配置、解绑及发布。
3. **发布入口**：发布对话框选择来源并确认，服务端持久任务自动固定包和排队；独立源码包入口保留。保存默认来源是独立可选配置，不与发布组成无法原子落盘的两次前端写入。
4. **验收目标**：使用隔离 Java/Maven 服务和静态站点，先核对测试节点的现有端口、Docker 网络和平台命名卷，明确健康响应。缺少必要目标时继续不受影响的实现与测试，并具体列出缺口。只读浏览不能计作真实发布。

任务取消、通用容器/SSR、数据库迁移、蓝绿发布等不在main既有范围；若用户额外要求，应另列新增需求和验收，不混入“完整迁移已完成”的声明。

## 9. 基线与变更范围复核

实施前调查执行过：`git merge-base --is-ancestor <mainSHA> <currentSHA>`，返回成功；`git ls-tree -r` 比较同路径 blob；`git show <mainSHA>:<file>` 读取固定 main 版本；当时对工作分支仅作只读调查。

main 证据链接均固定到上述 SHA 与文件行号，不随 main 后续更新漂移。本地代码链接指向工作分支实际文件，会随本批实现更新。各批实施前复核 HEAD、远端及其他 Agent 改动，不以调查快照覆盖后续新增提交。

调查确定的主要适配范围为：[autoops/contracts/deployments.ts](../autoops/contracts/deployments.ts)、[src/deployment-projects.mjs](../src/deployment-projects.mjs)、[agent-demo/t3-adapters/deployments.mjs](../agent-demo/t3-adapters/deployments.mjs)、[deployment-http.mjs](../agent-demo/t3-adapters/deployment-http.mjs)、授权公开入口及其动作策略、[vendor/t3code/apps/server/src/autoops/http/deployments.ts](../vendor/t3code/apps/server/src/autoops/http/deployments.ts)、[vendor/t3code/apps/web/src/autoops/deployments.ts](../vendor/t3code/apps/web/src/autoops/deployments.ts)、[DeploymentsPage.tsx](../vendor/t3code/apps/web/src/autoops/DeploymentsPage.tsx)、[DeploymentsPanel.tsx](../vendor/t3code/apps/web/src/autoops/DeploymentsPanel.tsx)、`deployment/`；引擎公开用例及档案边界按实际合同缺口扩展 [src/deployment.mjs](../src/deployment.mjs) 与 [SourceArchives](../src/source-archives.mjs)。`agent/` 原执行核心完整保留，不另建执行器。

## 10. 本批实施记录与验收进度

本批已完成上述范围的代码适配及定向本地回归，继续使用现有引擎、来源模块、项目授权和锁定 T3。四批对应关系如下；代码实施与发行验收分开，不据此宣布完整迁移验收完成。

| 批次 | 本批实际实施 | 主要证据入口 |
| --- | --- | --- |
| A：配置模型与存量保护 | 接通独立 Java/static 服务、多部署位置、服务 × 环境默认来源、配置条件校验和动作权限；事务内及任务领取时重查当前授权。原映射 `version=1` 保留，独立 `configurationVersion=1` 扩展配置和修改收据，未知版本拒绝，原服务/目标 ID 不变 | [项目公开用例与兼容测试](../test/deployment-projects.test.mjs)、[HTTP 授权测试](../test/deployment-http.test.mjs)；使用旧发行 `27fa5b349e9b5e0e30c105f453ffca45216f45ad` 的真实项目模块，在隔离 SQLite 数据副本上验证初始化及 `ensureProject` 不丢新增配置和收据 |
| B：Java 与静态发布主链 | 接通 Git 分支/标签/提交及最多 100 条历史；一次确认后持久任务自动固定源码包并排队。Java 发布/重启/回退与静态发布复用原执行核心；任务保存真实来源及冻结配置，原请求重试不受后续默认来源变化影响，停服排空后从原收据恢复 | [Git 选择测试](../test/t3-workspace-git-selection.test.mjs)、[工作区固定源码与恢复测试](../test/deployment-workspace-source.test.mjs)、[业务适配测试](../test/t3-deployments.test.mjs)、[发布弹窗交互](../vendor/t3code/apps/web/src/autoops/deployment/DeploymentDialogs.browser.test.tsx)；真实隔离 Java/静态发布仍须发行验收 |
| C：管理闭环与旧功能退役 | 接通节点接入/绑定/解绑/撤销/删除、存储策略与过期观测；接通版本分页、档案下载/受保护清理及日志搜索/筛选/复制/下载。节点写入保留原请求收据，策略带版本校验。删除旧 latest 下载、下载口令、旧下载页与 Jenkins 示例，版本化清理仅涉及专属旧字段 | [节点测试](../test/t3-deployment-servers.test.mjs)、[Agent 网关测试](../test/deployment-agent-gateway.test.mjs)、[旧字段退役测试](../test/workspaces.test.mjs)、[节点界面](../vendor/t3code/apps/web/src/autoops/deployment/DeploymentServers.browser.test.tsx)、[历史界面](../vendor/t3code/apps/web/src/autoops/deployment/DeploymentHistory.browser.test.tsx)及[日志交互](../vendor/t3code/apps/web/src/autoops/deployment/DeploymentLogs.browser.test.tsx) |
| D：恢复与发行验收 | 完整后端、Worker 与 Agent 包采用串行锁、独立 cgroup、活动任务检查、一致备份和程序回滚。首次候选安装检查失败后自动恢复原程序，业务数据未覆盖；安装资产定位及冷启动监听条件已纳入实际 Worker 预验。临时隔离验收环境发生挂载事故后已恢复并停用；真实新 Java/static 业务写流程仍需独立 Linux 目标 | 本工作树 `.deployment/deployment-core-20261025/` 保存失败复现、回归、发行和事故恢复证据；正式发行身份、健康及数据保留统一写入[当前验证发行](agent-demo-t3-deployment.md#当前验证发行) |

本节更新时的执行快照：后端组合 **142 项通过**，其中项目/源码/适配器相关 **41 项是该组合子集，不重复累计**；服务端 **6 项通过**。浏览器首轮 **121 项中 120 项通过**，旧标签断言修正后，Logs、RepositoryVersion、Access、Responsive 定向补跑均正常结束（退出码 0），不将补跑数量另加为新的总数。`check:runtime`、UI 构建和 Worker 构建均已正常结束（退出码 0）。服务目录与实际配置不一致的问题先以失败用例复现，修复后关联 **68 项通过**，亦不与上述组合累加。最终审查复现的配置修改收据漂移已修复，关联 5 个 Node 文件 **49 项通过**；旧下载字段在程序回滚后重新写入的问题也经真实旧模块与隔离 SQLite 复现并修复，关联 **30 项通过**，Git 凭证、部署 Agent 身份和历史保持不变。以上定向数量均不与组合结果相加，最终结果以运行记录为准。

首次 `8b5b9e59` 候选曾实际切换，安装脚本 503 触发自动程序回滚至 `27fa5b34`，没有恢复旧数据库。后续修复、重新发行及线上数据保留以当前验证发行的实际回执为准。程序回滚成功不等于 Java/static 业务回退通过；第 7 节的模拟、真实 HTTP、浏览器与真实 Docker/业务操作边界继续适用。核心应用 `8c434a1a` 已成功上线，日志工具栏后续发行 `cb2cda6a` 的两项 CI、发行校验、公网健康与数据保留也已通过，详见当前验证发行。原节点存储维护失败是发布前既有的 BuildKit 镜像拉取超时；没有改写策略或清缓存。D 批尚需独立 Linux 目标完成新增 Java/static 的真实发布、重启/回退、失败恢复、断线收据及存储策略验收，不能据应用上线宣布全部业务验收完成。未执行的完整上游套件也不算通过。

本节只保存实施范围及上述进度快照，不重复维护最终长验收表。后续完整命令、结果和核心操作步骤对比以[本批运行与验证记录](../docs/runtime-modules.md#main-部署核心适配2026-10-25)为准；实际提交、CI、发行校验、健康、数据保留与真实业务验收以[当前验证发行](agent-demo-t3-deployment.md#当前验证发行)为准。

## 11. 完整部署工作台整合设计（2026-10-25，待确认）

后续用户补充项目管理与环境 MCP 后，全局配置归属、从创建项目到使用功能的路径及权限细化统一见[工作台设计总图](project-workbench-design.md#项目建立与功能启用总图)和[权限设计](project-workbench-design.md#项目权限设计)。2026-10-26 明确的[仓库连接与分支选择分离](project-workbench-design.md#git-仓库与使用配置分离)及[简化权限](project-workbench-design.md#项目权限设计)同样适用，部署按环境角色授权，不逐服务或节点目标授权。本节此前原型的“工作区编辑来源”与分散配置入口作为历史演示记录保留；下一版原型按集中项目设置调整，不将旧交互记录作为新总图已实现的证据。

用户提供 main 的项目总览、Git 发布、历史回退、中心与 Agent 分阶段进度四张实图后，要求重新设计整合方案和可点击原型。本节是待确认的页面设计，补充第 5.2 节；不改变第 1—10 节的业务边界、实施事实和未验收项，也不代表已经上线。原型仅使用虚构数据、本地状态和模拟任务。

### 11.1 整合原则与导航

- 保留当前 AutoOps 公共顶栏、项目选择、模块导航与侧栏，继续锁定 T3 v0.1.1。main 作为功能依据，不迁入其独立后台壳、Solid Glass、登录或项目数据库。
- 顶部项目选择是唯一项目范围入口。部署首页更名为「服务总览」，只展示当前项目、当前环境的服务与部署位置；不再列出全部项目，不在部署内创建另一套项目管理。
- 部署侧栏提供「服务总览、发布记录、项目服务器」；「项目设置」紧随常用入口显示，不再藏在侧栏最底部，公共顶栏同时保留带文字的入口。项目选择菜单包含「创建项目」，创建后切入新项目设置。项目设置按总体规划提供基本信息、成员、代码仓库、凭证、环境及助手；「配置仓库」进入项目设置的同一连接记录，工作区入口只负责资料分支、导入范围和更新。环境详情配置 MCP 与服务器绑定，并进入同一服务配置。跨项目服务器和系统审计的管理入口只向平台管理员开放，不与项目配置混排。
- 环境使用主标题下方的紧凑页签，直接点击「测试环境、生产环境」切换；同一行右侧常驻文字按钮「管理环境」。环境只有一个时直接显示名称，不制造无意义的选择器；多个环境与长名称可换行，完整名称可访问，不能挤出管理入口。生产环境依照其类型以语义颜色及环境名称区分，不靠硬编码 ID。服务总览、发布记录及项目服务器使用同一部署浏览环境；发布、配置和任务详情显示已绑定环境，确认区再核对目标环境，不在详情里静默换目标。
- 环境属于项目，由「项目设置 → 环境」统一新增和配置名称、类型（测试/预发布/生产/自定义）及可选说明。环境详情提供 MCP 连接、部署服务器及本环境服务配置入口；MCP 仅能在环境配置中维护，部署不另建配置入口。服务配置与部署页面共用同一记录，环境行提供授权范围内的服务器关联数、部署位置数和「进入部署」。问答和部署读取同一环境标识及定义，再分别按服务端授权过滤：问答使用该环境绑定的 MCP，部署使用该环境的服务和服务器。新增环境不自动创建服务、绑定服务器或复制生产配置；类型不擅自修改已有构建 Profile、端口或运行配置。问答可选择已获授权的环境，没有真实观测数据时如实反馈。具体归属见[环境配置与问答调用](project-workbench-design.md#环境配置与问答调用)。
- 项目设置只维护 Git 仓库地址、凭证引用和连接状态，不保存业务分支。工作区自己选择资料分支、挂载目录与导入范围；部署服务引用同一仓库，在部署区独立选择任意获授权可读取的分支及具体 commit，构建/运行/健康检查配置归部署所有。部署可记住服务及环境自己的选择，但不继承工作区分支或导入目录，不回写项目仓库配置。上传的产品资料继续属于工作区，不变成部署包或按环境复制。两边通过公开 Git 能力获取源码，不共用可变工作目录。
- 同一环境目录不等于全站强制同步当前选择。问答草稿可选环境，已建立会话保留原环境；部署切换只影响浏览和下一次提交，已提交任务保留原项目、环境、服务、位置、SHA 与配置。切换项目后隔离选择与草稿，不能让同名环境跨项目串用。
- 默认保持紧凑连续列表；每行识别服务、分支、上次确认 commit、现场健康与发布动作。一个服务在同环境可有多个服务器位置，发布针对一个位置；多位置选择不能暗示原子批量部署。CPU、内存、磁盘及在线状态在服务器详情查看，过期观测显示时间及未知状态。

首次配置顺序为「顶部选择/创建项目 → 项目设置连接仓库 → 添加环境并绑定服务器 → 进入该环境部署 → 创建并配置服务 → 选分支与提交 → 确认发布」。空页面根据实际缺项提供下一步入口，不等用户提交失败后再提示去其他页面。创建服务时引用已绑定服务器和已有源码来源，同时创建当前环境的首个部署位置，再进入构建、运行和健康检查配置；不要求先创建空服务再回总览寻找位置配置入口。配置页直接提供「选择版本」。日常使用从「点击环境页签 → 服务行发布」开始，已配置资料不重复填写。环境名称修改使用稳定 ID 关联；有会话、任务、服务器或服务引用时，删除按引用保护处理，不能级联删除历史。

### 11.2 四个核心页面

| 页面 | 默认可见 | 展开后可用 | 主流程 |
| --- | --- | --- | --- |
| 服务总览 | 顶栏当前项目、环境页签和管理入口、当前环境的服务/部署位置、上次确认版本及提交说明、现场健康、发布 | 服务器资源、完整 SHA、服务新增/编辑、部署位置新增/复制 | 已配置时行内发布；缺少环境、服务器或来源时给出对应配置入口 |
| 发布工作台 | Git 提交 / 已发布版本页签；分支、搜索与提交列表；目标确认区 | 标签/完整 SHA、固定源码包、配置分组、完整版本信息；Java 当前版本重启 | 选 commit → 核对版本变化和服务器 → 确认发布；不要求手动生成包后跨页寻找 |
| 已发布版本 | 成功版本链、commit、时间、当前指针、来源发布/恢复关系、可恢复状态 | 当时配置、中央归档、恢复方式、受保护的清理 | 选版本 → 核对历史配置和目标 → 确认恢复；成功新增链节点，原历史不覆盖 |
| 任务详情 | 项目/环境/服务/服务器、结果摘要、中心与服务器两段阶段、所选阶段日志 | 任务快照、完整日志、搜索、复制、下载、源码包/清单 | 提交后直达；点阶段查看日志，离开页面不取消；阅读旧日志时不被新消息拉走 |

发布工作台采用原生工作区分栏：左侧版本列表，右侧约 280px 确认区；不足宽度时确认区顺序排到列表后，保留目标及确认按钮，不让横向表格溢出。项目与环境已确定时使用清晰的绑定值，不重复提供同名选择器；服务器仅在同服务同环境有多个有效位置时可选。需要换环境时返回服务总览选择，不能把当前确认草稿或任务改绑。

这是对第 5.2 节“发布弹窗”的呈现调整提案：确认后改成完整工作台，继续复用原有版本选择、配置与确认合同；危险动作的小型确认仍使用 Dialog。当前生产页面尚未按此提案改造。

中心阶段为「拉取代码 → 固定提交 → 打包 ZIP」，服务器阶段为「下载源码包 → 编译 JAR/构建前端 → 构建镜像（Java）→ 更新服务/切换站点 → 健康检查」。阶段顺序与真实任务事件对齐；显示阶段耗时，非真实数据不能画成完成。任务结果与现场健康分开，成功历史不替代实时观测。

Java 重启只用当前已成功版本及其历史配置，不拉源码、不构建、不更新版本链；静态站点不提供“重启 Nginx”。手动恢复优先用已核验本机产物，缺失则以中心原源码、历史配置及固定镜像重建，不读取当前分支或当前工作区。

### 11.3 main 能力完整映射

| 第 3 节编号 | 设计入口与责任 |
| --- | --- |
| 1、2、10 | 顶部项目、项目设置的统一环境目录、当前项目/环境的服务总览与位置配置；复用 access/catalog 与部署公共合同，保留服务/位置身份及引用保护 |
| 3、4、5 | 项目设置的仓库与凭证连接、工作区独立使用配置、服务仓库引用及发布版本选择；仓库与凭证各自只有一个所有者，不复制记录、缓存或秘密 |
| 7、8、9、21 | 项目服务器与全局服务器管理；接入、绑定/解绑、撤销、观测、能力、存储策略及执行回执；普通项目操作与全局共享影响分开 |
| 11、12、13 | 服务配置的「来源、构建、运行、健康检查」分组；Java/static 按类型显示字段，高级资源、网络、平台卷按需展开 |
| 14、15、16、17、18 | 发布工作台、Java 重启、版本恢复、任务详情；复用同一引擎、固定包、队列与原请求收据，不新增 UI 任务状态机 |
| 19、20 | 发布记录、两段进度、阶段日志、任务快照、版本链与源码归档；当前版本/恢复基线/活动引用禁止清理 |
| 22、23 | 页面恢复原任务、准确显示等待及未知结果；服务端继续拥有排空、断线补报、持久化和数据升级，不将其变成用户操作步骤 |
| 6 | 按用户决定彻底退役旧 Jenkins/脚本直取源码；中心固定归档、用户授权下载和部署 Agent 任务取包保留 |

### 11.4 状态、权限与操作约束

- 默认成功流程只有一次发布确认；选择版本、服务器不自动执行。配置保存属于“下次发布”，不能改写运行版本及历史快照。
- 2026-10-26 的保留边界统一见[工作区更新与部署归档](project-workbench-design.md#工作区更新与部署归档)：部署按需刷新分支提交，选择具体 Commit 后打包，成功进入版本链；中心长期保存链上版本所需源码包与恢复元数据。工作区各一份当前资料独立更新，活动/恢复/未知任务的临时包受保护，无引用临时包确认终态后回收，不改写本节此前原型验收事实。
- 编译失败：明确发布失败，原版本未切换。健康失败且恢复成功：显示“发布失败，已恢复原版本”。恢复失败：显示服务风险及失败阶段。断线：显示“正在核实结果”，按原任务查询，不提供重复发布或伪造取消。
- 有目标环境查看权但无部署操作权时显示只读内容；无该环境范围时不返回名称、日志、源码包或其他内容，不能以只读显示代替拒绝。写请求按该环境唯一生效角色裁决，不借项目发布角色覆盖环境只读限制；所有服务端调用仍重新检查。来源加载失败保留错误与重试，不能将错误当作空提交列表。
- 切项目关闭未提交确认并隔离草稿；已提交任务保留原绑定。共享服务器跨项目串行，页面显示排队，不能用本地倒计时冒充现场事件。
- 删除、解绑、撤销、源码清理按作用范围确认；平台或服务仍引用时拒绝，并说明引用对象。凭证只展示名称、用途和引用数，不返回明文。

### 11.5 实施范围与依赖

本次实际修改仅为本节和对话中的独立可点击原型，不改生产组件、API、数据库或发行。设计确认后的预期影响如下，实施前须再次核对实际调用图及新增提交：

| 文件/模块 | 预期改动原因 |
| --- | --- |
| `autoops/DeploymentsPanel.tsx`、`deployment/DeploymentControls.tsx` | 页面组合与定位，保留公开客户端、原收据及权限协调 |
| `deployment/DeploymentRepositoryVersionDialog.tsx`、`DeploymentSourceFields.tsx`、`DeploymentDialogs.tsx` | 将已有版本选择与确认组合为完整工作台，复用共享选择逻辑；不复制 Git 请求 |
| `deployment/DeploymentHistory.tsx`、`DeploymentSourceDetails.tsx` | 版本链、恢复关系、历史配置与归档入口 |
| `deployment/DeploymentLogs.tsx`、`deploymentPresentation.ts` | 两段真实阶段、耗时、阶段选择、快照和日志工具栏，保留游标与阅读位置 |
| `deployment/DeploymentServers.tsx`、`ConfigurationDetails.tsx`、`DeploymentConfigurationFields.tsx` | 将已有节点管理、观测和配置接入明确入口；保持数据及权限归属 |
| 项目设置、`ThreadScopeControl.tsx`、工作区源码来源与现有 catalog/source 公共客户端 | 补齐可发现的项目创建/基本信息与环境配置入口，复用统一目录与来源记录，分别过滤授权；部署使用引用和深链，不增加第二套配置状态。正式接入前核对现有环境类型/说明合同，缺字段时只在唯一所有者升级，不把原型字段当作已存在的后端能力 |
| `agent-demo/t3-adapters/deployments.mjs`、`deployment-http.mjs` 与公共 DTO | 仅在现有接口不能提供当前项目/环境的授权投影、来源引用或阶段数据时补充；不从 UI 直接读引擎存储，不预先承诺必须修改 |

复用对应：公共壳为 `AppSidebarLayout/ModuleWorkspace/WorkspacePageHeader`；紧凑导航为原生 Sidebar；列表/日志分栏参考 `FileBrowserPanel/fileSurfaceChrome/ScrollArea`；配置为 `settingsLayout/SettingsGroup`；确认使用原生 Dialog/AlertDialog。原型的独立 HTML 只表达布局和行为，正式实现必须组合上述真实 React 组件，不能把原型 CSS 直接搬入业务。

### 11.6 操作步骤、验收与确认边界

以下操作次数和第 11.7—11.8 节记录对应当时原型；其中“去工作区编辑仓库”等入口已由 2026-10-26 总体规划替代。保留原记录以便追溯，不当作新版交互已验证的证据；新版须按项目设置、环境授权和同一问答重新实际测量步骤与测试。

以下以用户提供的 main 截图作为结构基线，不冒充 main 实际交互测试；项目、环境、目标、权限及默认分支相同，已配好服务。下列次数为点击/选择次数，输入文本另计；等待独立记录。

| 核心任务 | main 截图可见流程 | 新原型流程 | 验证要求 |
| --- | --- | --- | --- |
| 从总览发布指定 commit | 发布 → 选 commit → 确认发布，3 次 | 发布 → 选 commit → 确认发布，3 次 | 不增加手动生成包；确认后固定目标、SHA 与配置，完成更新版本链 |
| 从服务工作台恢复旧版本 | 已发布版本 → 选版本 → 确认回退，3 次 | 已发布版本 → 选版本 → 确认恢复，3 次 | 原归档/配置、恢复关系、原记录保留；同 SHA 不同发布记录可区分 |
| Java 重启 | 重启当前版本 → 确认，2 次（确认从 main 代码核实） | 重启 → 确认重启，2 次 | 不执行中心源码及编译阶段，不新增成功版本节点 |
| 查看阶段日志 | 点击阶段，1 次 | 点击阶段，1 次 | 阶段高亮与日志同步；搜索、完整日志及下载仍可达 |
| 查看服务运行版本 | 总览直接可见，0 次 | 总览直接可见，0 次 | commit 与提交说明不藏进更多；版本收据与现场健康不混淆 |

本次范围修正另以此前原型为基线，以下开菜单与选择分别计数：

| 核心任务及初始条件 | 此前原型 | 修正后原型 | 验证要求 |
| --- | --- | --- | --- |
| 已选项目，切到生产环境查看服务 | 在多项目总览寻找正确项目 → 打开该组环境选择 → 选择生产；后两项 2 次操作，查找另计；第二版仍为打开选择器 → 选择生产，2 次 | 点击生产环境页签，1 次 | 仅当前项目及环境的数据，禁止夹入另一项目 |
| 在部署中修改仓库地址 | 打开部署「代码仓库」→ 编辑 → 修改 → 保存，4 次 | 管理源码来源 → 工作区编辑 → 修改 → 保存，4 次 | 编辑的是工作区同一条来源，已有服务引用即时反映名称/配置，历史快照保持原值 |
| 配置一个新测试环境，然后用于问答与部署 | 部署「环境」→ 添加 → 输入 → 保存，4 次；首版不能验证问答复用 | 部署「管理环境」→ 添加环境 → 输入名称 → 保存 → 该环境「进入部署」→ 顶部问答 → 打开问答环境选择 → 选择新环境，共 8 次；默认测试类型不另操作 | 只配置一次；两个模块同项目可选，同名或新增环境不泄露到其他项目。不能以未模拟的旧问答步骤声称减少次数 |

不以步数减少代替体验改善。本方案保持发布主链步数，消除重复项目层级和配置归属歧义；开发者维护单一环境/来源合同，部署不复制 CRUD；AI Agent 通过有名称的原生控件、稳定对象范围和显式结果识别入口，不向用户暴露 requestId 等内部标识。

原型须以浏览器实际点击验证主链、Java 重启、配置保存、项目/环境隔离、阶段日志、错误与恢复、Esc/焦点、浅深色及窄屏。原型演示不能计入真实发布验收；正式接入后追加相关单测、组件浏览器测试、受影响接口测试与隔离 Linux Java/static 发布验收。没有执行的上游完整套件、真实公网/目标操作和设备测试均不得宣称通过。

### 11.7 原型检查记录

首版使用内置浏览器操作独立原型的记录如下，均为模拟数据与浏览器交互，不是部署接口或真实服务器验收。范围修正后的复核另列在末尾，不将首版结果自动当作本版通过：

- 总览进入 Java 服务，选择指定提交并发布：中心 3 阶段、服务器 5 阶段完成，任务快照与所选完整 SHA 一致，成功写入新版本；模拟等待约 5.2 秒。
- 选择历史版本恢复：按原源码/历史配置路径执行，新增“恢复自 #45”记录，原历史仍在；随后重启仅显示“重启服务、健康检查”两阶段，成功版本总数仍为 5，没有新增版本节点。
- 编辑构建目录保存后配置页显示新值；再次打开编辑器并按 Esc，焦点返回原“编辑配置”按钮。
- 执行中切换到另一项目：新项目发布记录没有混入原任务；切回原项目后能找到同一个任务。断线演示按原任务核实，日志显示未重复提交；完整日志关键词筛选正确。
- 发布失败但恢复成功显示准确结果，保留原 commit；恢复也失败时显示服务异常，仍明确区分上次确认版本。只读模式的确认发布与重启均不可操作。
- 添加服务后先显示“尚未配置部署位置”，配置到测试服务器后才进入首次发布工作台；未发布时重启禁用。
- 检查浅色 1280×800、深色 1024×600、窄屏 390×600。窄屏实际预览内容宽 343px，文档无横向溢出，页面菜单、版本选择及确认区域可达；正式产品的真实触屏命中、满高面板滚动与粗指针仍须接入后验证。
- 最终脚本语法、片段结构及 `git diff --check` 检查；浏览器抽查无脚本错误。未运行生产单测/CI，因为本次未修改生产组件或接口；不将这些检查描述为生产业务通过。

本次未逐项实测原型内所有管理删除、下载、存储策略回执及并行排队分支。凭证与安装页面只演示入口和表单，不收集真实秘密、不生成真实安装命令；业务原型刷新后模拟任务数据重置。上述限制不缩减第 11.3 节的正式实现范围。

用户首次纠正项目、环境与仓库归属后，第二版（环境选择器方案）通过内置浏览器重新验证的历史记录：

- 默认只展示 AutoOps 工作台的两个测试环境服务；切到生产环境显示三个部署位置，离线备用位置不可发布。顶部切到企业业务平台后只显示订单服务。
- 在项目设置添加「预发布环境」后，问答和部署均可选择；另一项目的问答选项不含该环境。新环境没有自动复制服务器或部署位置。
- 在预发布环境创建演示对话，再切换部署到生产环境，原对话仍固定预发布环境。问答页面仅演示环境选择及绑定，不调用模型，不代表完整问答交互已接入。
- 从部署「管理源码来源」进入工作区，修改已有后端仓库名称；返回发布工作台后来源名称及确认区同步更新，没有创建第二条仓库记录。
- 在测试环境提交一次模拟 Java 发布，随后查看生产环境记录为空；切回测试环境找到同一任务 #64，完成后快照仍为测试服务器、原 SHA 和原构建配置。
- 环境重名保存显示明确错误，修正名称后成功保存；添加环境弹窗按 Esc 后关闭并恢复「添加环境」焦点。
- 检查浅色 1280×800、深色 1024×600 及窄屏 390×600。窄屏预览文档宽 343px、深色短窗口文档宽 977px，均无横向溢出；窄屏可切换模块及环境。浏览器两页均未捕获脚本错误。原型仍使用自包含页面滚动，生产的原生满高面板、真实触屏与完整问答流程须正式接入后验收。
- 最终执行脚本语法、无外部业务请求及 `git diff --check`。本轮只更新方案和原型，没有生产代码修改、真实部署或 CI 运行；未重复执行首版中不受本次导航及归属调整影响的全部故障、恢复、清理与排队演示。

### 11.8 配置闭环修正与复核

用户反馈环境切换仍不直观、项目与环境配置找不到。本次在第二版原型复现：项目选择只有已有项目；项目设置实际只进入环境名称列表；浏览器查询「创建项目」和「项目信息」入口均为 0。预期是能配置项目并从空项目走到首次发布，实际只能浏览预置数据。

核对的两个原因及证据：

1. `head/environmentBar` 的前身只放一个环境下拉框，没有相邻管理入口；`sidebar` 把项目设置放在底部，顶栏只有齿轮图标。浏览器确认入口存在但不易识别，属于信息层级问题；单纯放大选择器不能解决。
2. `navs/navigation/render` 没有项目信息页面，`new-project` 有处理分支却没有可触达入口；`envPage` 只支持名称，创建服务与创建部署位置分开，空态没有按缺项给出下一步。浏览器入口计数和实际页面与这些代码位置一致，属于流程缺项，不能靠增加说明文字补救。

实际修改范围仅为本节既有方案与 `deployment-integrated.html` 原型：项目入口和设置页、环境页签/管理页、空态、创建服务及配置页衔接、相关本地状态。发布/恢复引擎演示继续使用原任务处理；生产组件、服务端权限、真实数据库和部署均未修改。正式实现仍复用 T3 Sidebar、原生页签、项目/环境公共合同、设置分组与 Dialog，不把原型代码迁入生产。

| 核心任务（同为管理员） | 第二版操作 | 本版操作 | 实际验证 |
| --- | --- | --- | --- |
| 当前项目从测试切到生产 | 打开环境选择器 → 选择生产，2 次 | 点击生产环境页签，1 次 | 点击后切换到生产部署位置；离线位置仍不可提交 |
| 编辑当前项目名称 | 没有基本信息编辑页面，无法完成 | 项目设置 → 编辑 → 输入名称 → 保存，4 次 | 顶部项目名和设置页同步更新，项目标识及服务仍保留 |
| 从空项目完成首次发布 | 无创建入口；不能完成，不编造总步数 | 创建项目 → 添加环境 → 绑定服务器 → 添加来源 → 创建服务及位置 → 编辑构建配置 → 选择 commit → 确认发布 | 下述完整 25 次操作通过模拟发布；自动等待独立计算 |

首次发布用例初始条件：管理权限；已有一台可绑定的在线测试服务器；没有待创建的项目/环境/来源/服务；Java 类型、测试环境类型、公开仓库凭证、首个已绑定服务器及默认分支均适合该示例，不需要额外选择。完整操作为：打开项目菜单（1）→ 选择创建项目（2）→ 输入名称（3）→ 创建（4）→ 添加环境（5）→ 输入名称（6）→ 保存（7）→ 进入部署（8）→ 绑定服务器（9）→ 确认绑定（10）→ 配置源码来源（11）→ 添加仓库（12）→ 输入仓库名（13）→ 输入地址（14）→ 保存（15）→ 返回顶部部署（16）→ 添加服务（17）→ 输入服务名（18）→ 创建并配置（19）→ 编辑配置（20）→ 修改构建目录（21）→ 保存配置（22）→ 选择版本（23）→ 选择 commit（24）→ 确认发布（25）。不同凭证、服务器、服务类型、分支或构建要求需按实际增加选择及输入，不把这些步骤隐藏在自动处理中。

本版浏览器自动化交互结果：

- 创建「部署闭环验收」空项目、联调环境、服务器绑定、工作区源码来源和「验收 API」服务；配置构建目录 `backend`，选择 `578ebfc7ad32cabbfbf6c9e056024e7d32684937` 后模拟任务 #67 成功，返回列表显示该版本。中心/服务器共 8 阶段，定时演示约 5.2 秒；这不是实际 Git、构建或服务器耗时。
- 新增生产类型环境后，问答选项与部署页签都出现同一环境；生产标识来自类型，不依赖预置 `prod` ID。改项目名称同步显示；单一仓库/服务器展示确定值，无多余下拉选择，创建后引用正确。
- 空服务名显示「请输入服务名称」，填写后继续创建成功；只读演示账号的创建项目、编辑项目、添加/配置环境均禁用。该结果仅证明前端演示约束，不代表服务端越权测试。
- 浅色 1280×800、深色 1024×600、窄屏 390×600 实际查看；窄屏预览文档宽 343px，无横向溢出，项目设置和环境管理可达。Esc 关闭添加环境弹窗后焦点恢复「添加环境」。窄屏模块选择文字宽度已调整；浏览器未捕获页面脚本错误。
- 执行原型脚本 `node --check`、片段格式及无外部业务请求检查、仓库 `git diff --check`。未运行生产单测或 CI；项目/环境的真实持久化、授权、历史引用保护、长列表、完整键盘导航及接入后的满高滚动仍须正式实现与回归，不能把本次原型路径走通称为线上业务全部闭环。

本版改善分别是：用户能发现入口并完成首次配置；开发者通过唯一项目/环境/来源所有者与明确页面组合减少重复状态；AI Agent 可使用命名控件、当前对象和明确的成功/错误结果定位步骤。图示只证明静态呈现，上述交互记录才用于证明模拟流程。
