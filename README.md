# CodeMinificationRepository

一个自托管的源码交付与集中部署平台。中心在网页管理 Gitee 凭证、源码仓库、业务项目、环境和多台服务器；服务器 Agent 主动连接中心，下载完整 ZIP、编译 Java 项目、部署 Docker 容器，并持续回报日志和运行状态。

**第一版与 Jenkins 并行。现有 Jenkins 任务和业务容器继续由 Jenkins 管理，接入中心时使用「仅观察」模式。平台发布先在独立环境验证，不自动接管现有服务。**

Gitee 凭证只保存在中心，不写入镜像，也不下发给 Agent 或客户服务器。原有项目下载密码、浏览器入口和 Jenkins/API 下载方式继续兼容。

```text
中心控制面板（原源码服务）
  ├── Gitee → 指定分支 → 完整 ZIP 源码包
  ├── 服务器 A · 仅观察 Agent → Jenkins 管理的容器
  └── 服务器 B · 平台管理 Agent → 编译、发布、健康检查、回退
               ↑ 主动连接中心，持续回报状态与日志
```

从接入到首次独立发布的步骤、Java 示例配置和升级恢复方法见 [部署运维指南](examples/deployment-guide.md)。Agent 的运行目录、权限和恢复机制见 [Agent 说明](agent/README.md)。

## 下载行为

1. 验证项目下载密码；无效请求不触发 Git 操作。
2. 拉取管理员指定分支的最新提交，固定本次快照。
3. 提交未变时复用已生成的 ZIP；有新提交时生成新包。
4. 完整生成后才发布文件，返回版本和 SHA-256 校验值。
5. 同一项目正在同步时，并发请求等待同一任务；后续独立请求仍重新检查远端。

这里的“最新”指本次成功拉取时的分支状态。上游在打包期间又产生新提交时，由下一次请求获取。上游不可用、分支不存在或打包失败时返回错误，**不会悄悄返回旧包**。页面上的“最近成功同步”保留供诊断，不表示失败后仍允许下载旧包。

## Docker 部署

需要 Docker Engine 和 Docker Compose。中心镜像使用 Node.js 24、内置 SQLite 与 Git，没有第三方 npm 运行时依赖。Docker 构建时自动生成 Agent 安装包，中心容器无需挂载 Docker Socket。

在本项目目录执行：

```bash
docker compose up -d --build
docker compose exec code-minification-repository cat /data/bootstrap-token
```

打开 [本地管理页面](http://localhost:8080)，输入上面读取的初始化口令，创建管理员账号（密码至少 12 位）。口令仅供首次初始化，成功后删除；不会输出到服务日志。

默认只监听宿主机 `127.0.0.1:8080`。远程部署时可先使用 SSH 转发进行初始化：

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

然后在本机浏览器访问 [本地管理页面](http://localhost:8080)。

### 公网访问

复制 `.env.example` 为 `.env`，设置实际站点来源并启用安全 Cookie：

```dotenv
PUBLIC_ORIGIN=https://source.example.com
COOKIE_SECURE=true
BIND_ADDRESS=127.0.0.1
PORT=8080
```

在宿主机配置 HTTPS 反向代理，参考 `examples/nginx.conf`，然后执行 `docker compose up -d`。TLS 证书由部署环境配置。`PUBLIC_ORIGIN` 不带末尾斜杠或子路径，需要与浏览器实际访问地址一致；服务挂载在域名根路径。

使用本地明文 HTTP 调试时才设置 `COOKIE_SECURE=false`。公网下载密码必须通过 HTTPS 传输。代理读取超时要覆盖排队、拉取和打包时间，示例为 3600 秒。

## 网页使用

1. 在「Gitee 凭证」中新增凭证，填写名称、Gitee 用户名及 HTTPS Git 可用的密码或访问令牌。
2. 在「项目仓库」中新增项目，填写 `https://gitee.com/组织/仓库.git`、明确的分支名，并选择凭证。公开仓库可以不选凭证。
3. 保存后弹窗显示独立下载密码、浏览器下载地址及 Jenkins/API 地址。下载密码与 Gitee 凭证无关。
4. 将浏览器下载地址与项目密码提供给调用方，或把密码写入 Jenkins 的 Secret text 凭据。
5. 对外首次请求时才开始拉取；也可点击「立即同步」验证配置并预热源码包。

下载密码为随机生成的 256 位密钥，只保存哈希，**仅在创建和重置时显示**。后续无法找回原密码，可以重置；旧密码立即失效，包括尚在等待同步、未开始发送文件的旧请求。已经发送出去的内容无法收回。项目停用后拒绝新下载。编辑项目不会自动重置下载密码。

后台支持凭证更新、项目编辑、项目停用、密码重置、管理员修改密码和最近 100 条操作记录。会话有效期为 8 小时，重启或修改管理员密码后需重新登录。Gitee 凭证及项目下载密码不因容器重启而改变。

## 集中部署与 Jenkins 并行

中心新增「服务器」「业务项目」「部署目标」「发布记录」四个页面。管理关系为 **业务项目 → 环境 → Java 服务 → 服务器上的部署目标**；环境关联原有源码项目，服务指定 Maven 模块。

| 管理方式 | 可用操作 | 使用场景 |
| --- | --- | --- |
| 仅观察 | 查看主机指标及登记容器的状态 | 现有 Jenkins 服务器，保持原发布方式 |
| 平台管理 | 完整源码发布、重启、回退、健康检查 | 独立部署验证服务器 |

观察限制同时在中心和 Agent 执行，已有目标不能直接改模式或重新指定归属。安装 Agent 不会扫描后自动接管其他容器。部署、镜像、卷、网络和 Maven 缓存使用平台独立命名及目录，不共享 Jenkins 的构建目录。

平台发布会固定源码版本与配置快照，依次完成 ZIP 校验、Maven 编译、镜像构建、更新目标容器和 HTTP 健康检查。失败时尝试恢复上一成功版本；没有基线的首次发布会明确报告无法回退。每台服务器串行执行发布任务，不同服务器可并行。

中心分别显示 Agent 是否在线、任务是否成功、业务是否健康。超过 60 秒无心跳显示失联，保留最后采集时间，不把失联误判为业务停止。任务日志与阶段耗时可实时查看，断线后支持补报。每个目标保留最近 5 个成功版本及当前回退基线。

日志同时保存 Agent 的发生时间和中心接收时间，离线补报不会把编译耗时压缩成上传耗时。中心按首条事件估算时钟偏差，并限制后续时间单调递增；调整过的事件保留原始时间及调整标记。服务器应保持时间同步，旧客户端未提供时间时使用接收时间。

Agent 仅需出站 HTTPS，不需要独立域名或公网监听端口。安装后挂载宿主机 Docker Socket，具有近似宿主机管理员的容器管理权限；只在受信任的内部服务器使用。构建容器不挂载 Docker Socket，源码中的 Maven 插件仍会执行，因此只发布受信任的项目。

## Jenkins / HTTP 调用

```http
GET /api/projects/{项目ID}/source/latest
Authorization: Bearer <项目下载密码>
```

只接受请求头中的密钥，不接受 URL 参数中的密码，也不接受调用方指定仓库、分支、提交或路径。

成功响应：

| 响应头 | 含义 |
| --- | --- |
| `Content-Type: application/zip` | ZIP 源码包，根目录即项目文件 |
| `X-Source-Revision` | 本次源码对应的 Git 提交 ID |
| `X-Archive-SHA256` | ZIP 文件的 SHA-256 |
| `X-Archive-Cache` | `hit` 为远端检查后复用缓存；`miss` 为重新生成 |
| `Cache-Control: no-store` | 中间代理及浏览器不应公开缓存私有包 |

主要错误码：`401` 密码无效或项目停用，`413` 文件超限，`422` 包含未支持的子模块或 LFS，`429` 请求过频，`502` 拉取/打包失败，`503` 全局队列已满，`504` 同步超时。`429` 和 `503` 返回 `Retry-After: 60`。

完整 Linux Jenkins 示例见 `examples/Jenkinsfile`：

- 在 Jenkins 创建 ID 为 `source-download-password` 的 Secret text 凭据。
- 替换 `SOURCE_URL`，按照项目替换编译命令。
- 使用在 Jenkins 中直接配置的 Pipeline，或从独立部署脚本仓库读取。不要让客户 Jenkins 为读取此脚本而连接原始开发仓库。
- 构建节点需要 `curl`、`awk`、`sha256sum`、`unzip` 以及实际编译工具。
- 下载到临时文件，校验后解压到干净的目录；下载失败时中止构建。

浏览器下载页面为 `/download/{项目ID}`，输入密码后等待同步和下载。浏览器端暂用 Blob 接收完整 ZIP；大型项目优先使用流式下载的 Jenkins/curl。

## 持久化、备份与迁移

Compose 使用命名数据卷 `repository-data`，挂载到 `/data`：

```text
/data/
  master.key         Gitee 凭证的 AES-256-GCM 加密密钥
  state.sqlite       权威存储：管理员、源码配置、加密凭证、下载密码哈希、部署配置与任务状态
  state.json         旧版迁移来源或首次初始化快照；升级后不再更新
  bootstrap-token    仅初始化前存在
  cache/             服务端 Git 仓库与源码包缓存
  deployments/       固定到任务的源码包、源码元数据与独立日志文件
  migration-backup-*/ 首次迁移前保存的旧配置与密钥
```

`docker compose restart`、重建容器和升级镜像都保留数据。**不要执行 `docker compose down -v` 或删除此数据卷**，否则会丢失配置和密钥。

备份前先暂停提交新任务、等待 Agent 当前任务结束，再停止中心并备份**整个数据卷**以及镜像版本和 Compose 配置。`state.sqlite`、`master.key`、`deployments/` 必须一起保留；只备份旧 `state.json` 不会包含升级后的修改。Agent 的身份、任务游标和历史版本在目标服务器目录内，还需分别备份，不能用一个 Agent 的身份接入另一台服务器。

首次读取旧数据时，服务先保存迁移备份，再将原管理员、项目 ID、加密凭证和下载密码哈希迁入 SQLite。旧 `state.json` 留作快照，后续写入以 SQLite 为准。数据库损坏、版本不支持或已有数据缺失密钥时启动失败，不创建空配置替代。

升级失败时保留故障数据，将**升级前整卷备份与原镜像版本成对恢复**。不能直接把旧镜像接到已升级卷上继续运行：它可能读取过时的 `state.json`。具体恢复步骤见 [升级与恢复](examples/deployment-guide.md#升级备份与恢复)。只复制镜像不会复制凭证或任务。

凭证字段加密用于避免凭证明文混入配置导出，不能阻止同时拿到密钥与数据的宿主机管理员。此服务及其数据卷应仅部署在你控制的服务器。客户服务器仅存项目下载密码。

当前中心采用单实例、单数据卷部署，**不要让多个实例同时写同一个数据卷**；不支持横向扩容。源码缓存不对外静态暴露，旧缓存包在该项目后续同步时清理（保留至少一小时以兼容在途下载）。部署任务另存固定源码与日志，不能把 `deployments/` 当普通缓存删除；任务档案会持续占用磁盘，应监控数据卷容量。Git 对象缓存也可能保留曾拉取的内容，仅中心可访问。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | 本地 `./data`；容器 `/data` | 持久化目录 |
| `HOST` | `0.0.0.0` | 进程监听地址 |
| `PORT` | `8080` | 进程端口；Compose 中也用于宿主机映射 |
| `PUBLIC_ORIGIN` | Compose 为 `http://localhost:8080` | 管理请求来源与 Agent 安装命令的中心地址；远程接入需 HTTPS |
| `COOKIE_SECURE` | 进程默认 `true`；本地 Compose 为 `false` | HTTPS 下必须为 `true` |
| `MAX_CONCURRENT_SYNCS` | `2` | 不同项目的最大并行同步数 |
| `MAX_PENDING_SYNCS` | `20` | 全局待执行项目数 |
| `SYNC_TIMEOUT_SECONDS` | `180` | 单次任务开始执行后的 Git/打包超时，不含排队 |
| `MAX_ARCHIVE_MB` | `1024` | 原源码服务生成后允许交付的 ZIP 上限，单位 MiB |

大小限制在生成后检查，不代表 Git 仓库或打包期间的磁盘配额。请为数据卷设置宿主机磁盘容量监控。默认每项目每分钟最多 60 个有效下载请求；失败鉴权和登录另有限流。服务不信任客户端提供的转发 IP，反向代理场景下按代理地址计数的登录限制由所有访问者共享，可在可信入口另外做细分限流。

**Agent 第一版单独限制 ZIP 不超过 64 MiB、单个解压文件不超过 32 MiB、总解压体积不超过 1 GiB。** 这些限制与原 Jenkins 下载上限独立；中心允许下载 1 GiB，不代表 Agent 可以部署同样大小的 ZIP。超限明确失败，不会改成增量传输或跳过校验。Agent 本身默认内存上限为 256 MiB，构建和业务容器另按模板设置资源限制。

## 交付内容与边界

- 当前支持 Gitee 公有站点的 HTTPS Git，不支持 SSH、自定义 Git 域名、Git LFS 和子模块。检测到 LFS 指针或子模块时明确失败，避免交付缺文件的包。
- 使用 `git archive` 导出当前树，不包含 `.git` 或提交历史；响应头提供本次提交 ID 便于追踪。
- `.gitignore` 不会排除已经提交的文件。需要在源仓库 `.gitattributes` 中设置 `export-ignore`，并确认不要排除编译所需文件。例如：

```gitattributes
.env export-ignore
.env.production export-ignore
internal-docs/ export-ignore
```

- 服务不自动识别业务密码或删除被跟踪的配置文件。提交在源码里的敏感内容仍可能交付，需要在源仓库清理或明确排除。
- 编译脚本如依赖 `.git`、`git describe` 或 Git 版本插件，需改为读取 Jenkins 获取的 `X-Source-Revision`，或允许无 Git 元数据构建。
- 源码包只提供当前版本；调用方不能列出历史包，但已经下载过的内容可自行保存。
- 中心的源码同步不会执行仓库构建脚本或钩子；编译在已登记的平台管理 Agent 上执行。Gitee 凭证通过临时进程环境及 askpass 传递，不写入仓库 URL、镜像、响应或日志。
- 平台不自动配置业务域名、证书或中间件，不执行全局 Docker 清理。真实项目副本需提前隔离数据库、Redis 数据空间、RabbitMQ vhost 和 MinIO bucket，避免并行环境相互影响。

## 本地运行与验证

需要 Node.js 24+、Git 和 `tar`，运行时无需 `npm install`。`npm start` 会先生成 Agent 安装包；直接运行 `node src/server.mjs` 前需手动执行 `npm run bundle:agent`。

PowerShell：

```powershell
$env:COOKIE_SECURE = 'false'
$env:PUBLIC_ORIGIN = 'http://localhost:8080'
npm start
```

Linux/macOS：

```bash
COOKIE_SECURE=false PUBLIC_ORIGIN=http://localhost:8080 npm start
```

验证命令：

```bash
npm run check
npm test
npm run bundle:agent
npm run test:browser
npm run test:deploy-browser
npm run test:docker
docker compose config --quiet
```

`check` 执行语法检查；`npm test` 使用临时本地数据、Git 仓库及测试凭证，覆盖源码鉴权、会话/CSRF、SQLite 迁移、任务调度、恢复和观察权限等逻辑，不连接真实 Gitee 项目或业务服务器。

两个浏览器命令需要 Chrome/Chromium/Edge，可通过 `BROWSER_PATH` 指定路径。原浏览器测试验证源码管理流程；部署浏览器测试使用真实中心和模拟 Agent 回报验证管理配置、观察隔离、发布/回退页面、SSE 日志和移动布局。截图保存到被 Git 忽略的 `.test-artifacts`。

`test:docker` 是单独执行的真实集成验收，需要可用的 **Linux Docker 引擎**、镜像拉取和 Maven 依赖访问能力。它使用本地 Java 演示项目、临时中心与两个 Agent，创建独立容器和网络，验证编译、发布、重启、失败回退及观察隔离；不会操作现有业务容器。输出报告位于 `.test-artifacts/docker-verification.json`。运行命令和验收方法不表示当前环境已经验收或上线，结果以实际命令输出与报告为准。
