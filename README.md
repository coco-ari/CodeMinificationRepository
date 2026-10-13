# CodeMinificationRepository

一个自托管的 Gitee 源码分发服务。部署后在网页添加 Gitee 凭证、项目和固定交付分支，为每个项目生成独立下载密码。客户通过网页或 Jenkins 请求下载时，服务先检查远端最新提交，再返回不包含 `.git` 的 ZIP 源码快照。

不需要把 Gitee 凭证写进镜像，也不需要在客户服务器配置 Gitee 账号。源码在客户 Jenkins 上编译。

## 下载行为

1. 验证项目下载密码；无效请求不触发 Git 操作。
2. 拉取管理员指定分支的最新提交，固定本次快照。
3. 提交未变时复用已生成的 ZIP；有新提交时生成新包。
4. 完整生成后才发布文件，返回版本和 SHA-256 校验值。
5. 同一项目正在同步时，并发请求等待同一任务；后续独立请求仍重新检查远端。

这里的“最新”指本次成功拉取时的分支状态。上游在打包期间又产生新提交时，由下一次请求获取。上游不可用、分支不存在或打包失败时返回错误，**不会悄悄返回旧包**。页面上的“最近成功同步”保留供诊断，不表示失败后仍允许下载旧包。

## AI 运维源码插件

项目设置可开启「AI 运维源码快照与增量下载」，选择定时同步周期，并立即同步生成首个版本。管理端提供源码服务根地址、项目 ID 和同一项目下载密码，填写到 AI 运维工具的源码插件即可。用户端无需 Git：首次下载完整固定快照，随后按 SHA-256 仅下载缺少的文件对象，用户手动决定何时更新。

此能力默认关闭，原 Jenkins/API 下载路径、鉴权和失败语义保持兼容。快照发布失败会保留带失败状态的已发布版本，不影响已成功生成的旧接口 ZIP。新增接口、限制和通知见 [源码快照 API](docs/source-api.md)，设计见 [实施方案](docs/source-snapshot-plan.md)。

## Docker 部署

需要 Docker Engine 和 Docker Compose。镜像使用 Node.js 24 与 Git，没有第三方 npm 运行时依赖。

在本项目目录执行：

```bash
docker compose up -d --build
docker compose exec code-minification-repository cat /data/bootstrap-token
```

打开 <http://localhost:8080>，输入上面读取的初始化口令，创建管理员账号（密码至少 12 位）。口令仅供首次初始化，成功后删除；不会输出到服务日志。

默认只监听宿主机 `127.0.0.1:8080`。远程部署时可先使用 SSH 转发进行初始化：

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

然后在本机浏览器访问 <http://localhost:8080>。

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
  state.json         管理员密码哈希、项目配置、加密凭证、下载密码哈希与操作记录
  bootstrap-token    仅初始化前存在
  cache/             服务端 Git 仓库与源码包缓存
  sources/  启用后生成的不可变源码快照、文件对象与发布指针
```

`docker compose restart`、重建容器和升级镜像都保留数据。**不要执行 `docker compose down -v` 或删除此数据卷**，否则会丢失配置和密钥。

备份时先停止服务，再备份整个数据卷；至少一起保留 `state.json` 和 `master.key`。迁移时将数据恢复到新服务器挂载的卷即可。只复制镜像不会复制凭证。备份可以不包含 `cache`，下次下载会重新拉取。

凭证字段加密用于避免凭证明文混入配置导出，不能阻止同时拿到密钥与数据的宿主机管理员。此服务及其数据卷应仅部署在你控制的服务器。客户服务器仅存项目下载密码。

当前采用单进程、单数据卷部署，**不要让多个实例同时写同一个数据卷**；不支持横向扩容。缓存并不对外静态暴露，旧包在该项目后续同步时清理（保留至少一小时以兼容在途下载）。Git 对象缓存可能保留曾拉取的内容，仅服务端可访问，磁盘需按仓库体积规划。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | 本地 `./data`；容器 `/data` | 持久化目录 |
| `HOST` | `0.0.0.0` | 进程监听地址 |
| `PORT` | `8080` | 进程端口；Compose 中也用于宿主机映射 |
| `PUBLIC_ORIGIN` | Compose 为 `http://localhost:8080` | 浏览器管理请求允许的来源 |
| `COOKIE_SECURE` | 进程默认 `true`；本地 Compose 为 `false` | HTTPS 下必须为 `true` |
| `MAX_CONCURRENT_SYNCS` | `2` | 不同项目的最大并行同步数 |
| `MAX_PENDING_SYNCS` | `20` | 全局待执行项目数 |
| `SYNC_TIMEOUT_SECONDS` | `180` | 单次任务开始执行后的 Git/打包超时，不含排队 |
| `MAX_ARCHIVE_MB` | `1024` | 生成后允许交付的 ZIP 大小上限 |

大小限制在生成后检查，不代表 Git 仓库或打包期间的磁盘配额。请为数据卷设置宿主机磁盘容量监控。默认每项目每分钟最多 60 个有效下载请求；失败鉴权和登录另有限流。服务不信任客户端提供的转发 IP，反向代理场景下按代理地址计数的登录限制由所有访问者共享，可在可信入口另外做细分限流。

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
- 原下载接口只提供本次确认的最新版本。新增快照接口不提供 Git 历史，可按已知快照 ID 读取尚未清理的同来源快照；已下载内容可自行保存。
- 源码分发服务不会执行仓库里的构建脚本或钩子。Gitee 凭证通过临时进程环境及 askpass 传递，不写入仓库 URL、镜像、响应或日志。

## 本地运行与验证

需要 Node.js 24+ 和 Git，运行时无需 `npm install`。

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
docker compose config --quiet
```

测试使用临时本地 Git 仓库和测试凭证，不接触真实 Gitee 项目。覆盖项目权限、密码重置、凭证加密与重启恢复、并发合并、全局队列、同步失败、HTTP 会话/CSRF、真实 Git 分支快照、历史隔离、缓存刷新、大小限制和真实 HTTP Git 凭证认证（包括带空格的数据路径）。

已安装 Chrome/Chromium/Edge 时，还可执行 `npm run test:browser`；自动检测常见安装路径，或通过 `BROWSER_PATH` 指定。使用无头浏览器验证管理流程和移动布局，截图保存到被 Git 忽略的 `.test-artifacts`。测试结束关闭测试进程并清理临时数据。
