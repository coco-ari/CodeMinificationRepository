# A / B 并行部署验证记录

> 后续配置整理：越南 SOL 项目现在只保留一个可发布的“测试环境”，原“Agent 验证”的部署配置和历史完整保留。本文保留验收时的环境名称；当前结构见 [单一测试环境整理](sol-test-environment-20261015.md)。

日期：2026-10-15（北京时间）。本记录只记载本轮实际观察和执行的结果。

## 环境盘点

| 项目 | A：129.226.133.152 | B：192.168.31.154 |
| --- | --- | --- |
| 用途 | Jenkins、四个 Java 服务、共用中间件和 Agent | 源码分发及部署中心 |
| 资源 | 约 3.5 GiB 内存、4 GiB Swap；验证前可用内存约 1.1 GiB | 约 7.8 GiB 内存；验证前可用约 5.8 GiB |
| 现有入口 | 本机 systemd Nginx，非 Docker Nginx | ZeroTier `172.29.254.212:8080` 经公网代理到 `https://bst-tmp.996788.xyz` |
| Java | `brezze-communication`、`brezze-api`、`brezze-manage`、`brezze-reward` | 无业务 Java 服务 |
| 中间件 | MySQL 8.4、Redis 6.2、RabbitMQ 3.9、MinIO；Docker 网络 `test-middleware` | 其他项目容器未作变更 |

A 的现有 Java 端口为 localhost 的 10110、10111、10112、10115。Nginx 保留原 `/communication`、`/api`、`/manage`、`/reward` 路由，TLS 与续签配置未改动。

Jenkins 使用 `maven:3.9.9-eclipse-temurin-8` 临时构建容器，通过 `-pl <模块> -am clean package` 构建目标模块。Java 运行参数包含 `test` profile、192 MiB 堆、128 MiB Metaspace；健康检查请求各服务的 `swagger-resources`。这只能证明启动及 HTTP 就绪，不能代替业务接口验收。

## 中心升级

- 完整数据卷及旧运行目录备份：B 的 `/opt/cmr-upgrades/20261015-workspaces/backup/`，仅 root 可访问。
- 旧镜像：`code-minification-repository:before-workspaces-20261015`，镜像 ID `sha256:fb15cea32fe2876d0e413875c215487efdd1030ff0052b34d3a62996ec150d43`。
- 新镜像：`code-minification-repository:workspaces-20261015`，镜像 ID `sha256:351900264bd7e42c59ae2172589ed17097b5c1219382ceec9a9e322dd3c8d0fb`。
- 发布来源为当前工作区，非新的 Git 提交。逐文件摘要见 B 的 `/opt/cmr-upgrades/20261015-workspaces/release/release-manifest.json`。
- 新镜像复用旧中心的 Node 24.21 运行时，装入本地已经构建和验证的前端及新版服务端；构建记录保留在版本目录。
- 先在独立数据副本上验证迁移，再更新正式中心。一个仓库、一个项目、四个服务、四个原观察目标保留 ID；生成四条环境源码关联及一个服务器绑定。
- 管理员实际用户名为 `admin`。管理员密码数据、共享凭证、下载密钥哈希及 Agent 身份均与升级前逐项比较一致。
- 当时验证了原 Jenkins 下载入口和 `p-vi-sol` 分支；该独立下载能力已于 2026-10-25 退役，本文不再提供接入地址。
- 公网登录、中心健康接口及原 Agent 自动重连已通过；原四个 Jenkins 容器的启动时间未变化。

## 并行验证配置

项目保留“测试环境”供原 Jenkins 服务观察，另建“Agent 验证”环境。服务器启用平台部署能力，原四个目标继续保持 `observe`。新目标独立管理容器、版本和日志，均使用共用的 `test-middleware` 网络及原测试 profile。

A 沿用已安装的 Agent 1.0.0，未重新注册或替换身份；本轮 Java 发布验证了它与新版中心的兼容性。静态站点能力另在 B 的独立 Docker 环境使用 Agent 1.1.0 验证，尚未在 A 部署前端站点；后续如要在 A 发布静态站点，需要升级 Agent 并根据本机实际 Nginx 方式配置产物目录。

| 服务 | Agent 验证宿主端口 | 容器内端口 |
| --- | --- | --- |
| communication | 127.0.0.1:20110 | 10110 |
| api | 127.0.0.1:20111 | 10111 |
| manage | 127.0.0.1:20112 | 10112 |
| reward | 127.0.0.1:20115 | 10115 |

`communication` 保留 Jenkins 的 `--ybt.enable=false` 参数。验证不导入数据库、不修改原 Nginx 路由，也不替换 Jenkins 容器。

盘点发现 `api`、`manage`、`reward` 原源码中的 `call.*.path` 指向 `127.0.0.1`，现有 Jenkins 容器没有对应的环境变量或启动参数覆盖。独立容器不能通过自己的 localhost 访问其他 Java 容器。Agent 验证目标使用运行参数将这些地址覆盖为对应 `cmr-<目标 ID>` 的 Docker DNS 名称；原 Jenkins 参数保持原样。原流程若需要完整业务联调，也需要另行修正这组调用地址。

用户确认可以临时暂停 Jenkins 让出内存，随后改用直接 SSH 操作 A。确认四个 Jenkins 任务均已结束且队列为空后，暂停 `cmr-jenkins-test-jenkins-1`、`cmr-jenkins-test-agent-1`；原四个业务 Java 服务及中间件继续运行。逐个构建和验证，必要时停止已验证的 Agent 副本。结束前已恢复 Jenkins 控制器与构建节点，完成原任务只构建回归。

## 验证状态

- 本地自动测试：70 项，69 通过，1 项 Linux 专属检查在 macOS 跳过。
- B 的隔离 Linux 容器补测 Agent 和构建测试：22 项全部通过，无跳过，覆盖 Linux 内核锁。
- 浏览器回归：通过桌面、手机、服务器接入、观察权限、源码配置、发布日志、耗时、版本回退及静态站点配置流程。
- A：真实 API 发布任务 `79883f40-a123-4794-9d72-3004cc05d487` 成功，固定提交 `dc1420de0ba15319bffaa5a413dfc8f17dda8892`。源码准备 6.342 秒、排队 1.601 秒、下载 16.673 秒、构建 154.080 秒、启动 2.086 秒、健康检查 45.263 秒。
- A：故意设置不匹配的健康响应，任务 `4d7dd572-3813-453e-ac93-a06cd4c6f1aa` 返回 `rolled_back`，恢复上述成功镜像并重新通过健康检查。之后已恢复正常的健康检查配置。
- A：communication 任务 `28ccb5d1-c343-48e4-972d-d46d9187b2fb` 成功，localhost 20110 的 Swagger 响应验证通过。
- A：manage 任务 `79d41ef8-cceb-497d-b14e-80833fa30091`、reward 任务 `3cb1343c-bef8-409d-828b-88be136da7ba` 均成功，localhost 20112、20115 的 Swagger 响应分别验证通过。
- A：API 第二个版本 `bbc4e428-8d56-4bdd-94cf-d197a4577ddc` 发布成功，包含 Docker DNS 服务调用参数，仍固定同一源码提交。源码准备 0.646 秒、排队 5.516 秒、下载 16.174 秒、构建 88.177 秒、启动 1.548 秒、健康检查 45.968 秒。各服务的源码 ZIP SHA-256 相同，为 `675bcea4e9029341941976222b108e70916cbb9627964b1e474a80c7bec2c93a`。
- A：手动回退任务 `48796843-da37-436e-9d53-ec53821a5601` 成功恢复 API 第一个版本；任务 `36ad5dd1-eb5f-4147-beb9-b5bb50e59c88` 成功恢复第二个版本。communication 重启任务 `1247186c-d26d-470a-b635-ba20d5a59be8` 成功。中心按服务器串行领取任务。
- A：短暂同时运行 API 与 communication，从各自容器通过 Docker DNS 请求对方 `swagger-resources`，双向 HTTP 200 且响应结构正确；未执行业务数据写入接口，也未把四个验证副本同时长期运行。验证后四个副本全部停止，保留镜像、配置、版本与日志。
- A：恢复 Jenkins 后执行原 `solstandard-api-test #4`，明确传入 `DEPLOY=false`，结果 `SUCCESS`，耗时 86.697 秒。通过原下载 URL 与原 Jenkins 凭证下载的提交及 ZIP SHA-256 与 Agent 完全一致。四个任务配置文件哈希未改变，构建节点在线、队列为空。
- A：最后逐项对比八个原业务及中间件容器，容器 ID、镜像、启动时间、重启次数均与验证前一致，全部健康；Nginx 正常运行。验证副本均已停止，Agent 在线，Jenkins 控制器与构建节点保持运行。
- B：独立 Docker 验收 7 个场景、15 个任务全部通过：观察隔离、Java 发布/重启/编译失败保护、自动及手动回退、中心离线继续执行与补报、编译中和健康检查中 Agent 崩溃恢复、跨项目串行执行、共用 Nginx 静态发布及回退。验收控制器、测试 Agent、业务与 Nginx 测试容器均已清理，报告和日志保留在版本目录。

本轮 A 共执行 9 个 Agent 任务：8 个成功，1 个为故意制造健康检查失败后成功自动回退。五个成功发布版本与全部任务日志保留在项目的“Agent 验证”环境。容器目前显示“已停止”是验收后的主动资源回收状态，不代表上述发布失败；失败回退记录中的“需关注”同样来自明确设计的故障测试。

机器可读证据保存在工作区 `.test-artifacts/parallel-center-evidence-20261015.json`、`.test-artifacts/parallel-a-evidence-20261015.json`。远程原始记录分别在 B 的 `/opt/cmr-upgrades/20261015-workspaces/` 和 A 的 `/opt/cmr-agent/verification-20261015/`。本轮完成部署基础链路验收，包括编译、容器启动、HTTP 就绪、两个服务双向网络访问与回退；未执行完整业务流程回归，也未切换原 Nginx 流量。

## 回退约定

中心数据已迁移，不能直接用旧镜像读取新数据卷。需要停止新版中心，保留当前数据副本后，将 `center-data.tar.gz` 恢复到独立数据卷，并与上述旧镜像配对启动；同时恢复 `center-files.tar.gz` 中的旧部署文件和环境配置。恢复后核对原绑定地址、登录、固定版本档案及 Agent 心跳。若新版已创建验证容器，应先记录其状态；恢复旧中心数据不会自动停止它们。

备份包含原有密钥及凭证，只保存在 B 的受限目录，未复制到代码仓库。
