# CodeMinificationRepository

一个自托管的源码交付与集中部署平台。中心以项目工作空间组织代码仓库、服务器、环境与服务，管理员在项目内完成部署和发布；服务器 Agent 主动连接中心，下载完整 ZIP、编译 Java 项目并部署容器，或构建 Vue / React 静态站点并发布到已有的共用 Nginx，持续回报日志和运行状态。

## 项目工作台交互原型

完整需求、模块设计、实现边界及跨电脑开发步骤见 [项目工作台设计与开发交接](examples/project-workbench-design.md)。当前工作台开发分支为 `feat/project-workbench-prototype`，尚未合并到 `main`。

在仓库根目录运行 `pnpm install`、`pnpm dev:prototype`，然后打开 [交互原型](http://127.0.0.1:5173/prototype.html)。原型采用现有 Solid Glass 与 shadcn/ui，提供两个隔离的示例项目，配置、文档、产物和对话保存在当前浏览器中。左下角重置按钮可恢复初始数据。

推荐按以下顺序体验：

1. **资料与配置 → 插件配置**：开启日志分析，填写配置，保存草稿，再应用配置；到项目工具打开插件。
2. **研发资料 / 仓库与源码**：新增、编辑或上传 Markdown / 文本资料，修改仓库配置并模拟同步。
3. **源码与产物**：查看文件与来源，生成去 Git、脱敏、ZIP 或报告等独立产物；下载 ZIP 可实际解压。
4. **Agent 对话**：从资料或产物进入问答，输入“检查项目设备并生成报告”，完成范围澄清，查看流式输出、工具轨迹、引用和报告；支持停止、继续及排队补充。
5. **服务与部署 / MCP 与连接 / 我的主机**：体验模拟发布、连接状态检查和个人 Agent 登记。

数据与执行结果均为模拟，不会连接真实仓库、服务器、数据库或模型。正式控制台仍从原入口访问。原型入口随 `pnpm build` 输出到 `dist/web/prototype.html`；浏览器验收使用 `pnpm test:prototype`，运行前需启动原型服务，可通过 `PROTOTYPE_URL` 指定地址。

首版静态设计资料保存在 [原型图集](output/imagegen/workbench-prototype-20261020-v1/index.html)，包含四张 PNG 和生成提示词。静态图作为设计过程存档，最新界面以交互原型为准。

---

**第一版与 Jenkins 并行。现有 Jenkins 任务和业务容器继续由 Jenkins 管理。服务器接入后直接提供部署能力，平台只管理自己创建的目标。平台发布先在独立环境验证，不自动接管现有服务。**

Gitee 凭证只保存在中心，不写入镜像，也不下发给 Agent 或客户服务器。原有项目下载密码、浏览器入口和 Jenkins/API 下载方式继续兼容。

**直接试用已配置的 Java 服务：** 见 [Java 服务部署操作手册](examples/java-operator-manual.md)，包含 A / B 当前环境入口、一键发布、版本回退、内存不足时暂停与恢复 Jenkins 的具体步骤。本版实际验证范围见 [2026-10-15 验收清单](examples/release-checklist-20261015.md)，已上线的实机结果见 [并行部署验证记录](examples/parallel-verification-20261015.md)。

**最新控制台更新：** 见 [完整原型落地与 B 中心更新](examples/prototype-rollout-20261015.md)，包含项目卡片、完整发布工作台、真实 Git 提交选择、验收结果和回退位置。

```text
中心控制面板（原源码服务）
  ├── Gitee → 指定分支 → 完整 ZIP 源码包
  ├── 服务器 A · Agent → 项目构建、部署与状态上报
  └── 服务器 B · 平台管理 Agent → 编译、发布、健康检查、回退
               ↑ 主动连接中心，持续回报状态与日志
```

从接入到首次独立发布的步骤、Java 示例配置和升级恢复方法见 [部署运维指南](examples/deployment-guide.md)。Agent 的运行目录、权限和恢复机制见 [Agent 说明](agent/README.md)。

前端部署只使用临时 Node 构建容器，不另起 Nginx。首次由运维给现有 Docker Nginx 挂载产物目录并配置站点，后续发布原子切换目录、验证站点版本并支持回滚。需要 Agent 1.1.0 及新增静态目录挂载，具体见 [前端静态站点部署](examples/static-sites.md)。

## 下载行为

1. 验证项目下载密码；无效请求不触发 Git 操作。
2. 拉取管理员指定分支的最新提交，固定本次快照。
3. 提交未变时复用已生成的 ZIP；有新提交时生成新包。
4. 完整生成后才发布文件，返回版本和 SHA-256 校验值。
5. 同一项目正在同步时，并发请求等待同一任务；后续独立请求仍重新检查远端。

这里的“最新”指本次成功拉取时的分支状态。上游在打包期间又产生新提交时，由下一次请求获取。上游不可用、分支不存在或打包失败时返回错误，**不会悄悄返回旧包**。页面上的“最近成功同步”保留供诊断，不表示失败后仍允许下载旧包。

## Docker 部署

需要 Docker Engine 和 Docker Compose。中心使用 Node.js 24、内置 SQLite 与 Git。界面采用 React、Tailwind CSS 和 [shadcn/ui](https://ui.shadcn.com/docs/components)；Docker 多阶段构建会安装锁定的前端依赖并生成静态资源，运行镜像不包含 node_modules。构建时同时生成 Agent 安装包，中心容器无需挂载 Docker Socket。

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

## 项目工作空间

登录后首先进入项目列表。点击「创建项目」会同时建立“测试”和“生产”两个空环境；默认进入测试环境。旧项目迁移时保留原环境，不自动添加或重命名。

项目概览中的接入清单按已保存的数据计算进度：创建项目 → 连接仓库 → 确认环境 → 接入或绑定服务器 → 配置服务 → 首次发布。已接入服务器暂时离线不会重置接入进度，发布前仍检查在线状态。

1. **接入配置 / 代码仓库**：添加 Gitee 仓库地址及访问凭证，不填写分支。中心查询远端 HEAD 识别默认分支；连接失败保留记录，支持重试。
2. **接入配置 / 环境管理**：管理测试、生产等环境。服务页面顶部统一选择当前环境，仓库和项目服务器属于项目级资源。
3. **接入配置 / 项目服务器**：绑定已有服务器，或生成新服务器的 Agent 安装命令。同一服务器只需安装一次 Agent，可供多个项目复用。
4. **服务与部署**：新增服务时依次保存服务信息、当前环境源码、部署配置。已保存步骤可稍后继续，保存配置不会自动发布。同环境、同服务的部署位置共用源码选择，构建和运行配置分别保存；端口和卷通过结构化行配置。
5. **发布记录**：查看任务阶段、耗时、实时日志、固定源码与配置快照。服务详情提供运行状态、配置、发布记录三个页签，区分下次发布配置和已部署配置。

服务列表保留“发布”主操作，“更多操作”只提供重启和回退。点击服务名称进入运行状态、配置和发布记录；在配置区域编辑对应范围。多服务器部署需展开后选定部署位置。离开未保存的表单或切换环境时会提示；列表支持搜索、状态筛选、排序和分页，记录范围以页面提示为准。

项目首页使用等高卡片，每页完整显示三个服务，底部箭头切换分页，点击服务数量进入完整列表。服务按固定顺序排列，状态刷新和发布进度不会改变位置；切换环境从第一页开始，返回首页保留所选环境和页码。每个服务直接显示名称、运行状态、分支和 Commit，点击 Commit 可复制完整提交号。分支优先取发布快照，无法确认时显示配置的发布分支并在提示中注明；不使用仓库默认下载分支或最新源码提交替代运行版本。已运行但缺少版本信息时显示“版本待识别”，多个部署位置版本不一致时进入服务详情查看。单位置点击“更新”进入发布工作台，多位置从更新按钮选择服务器。最近发布失败不会覆盖旧版本仍正常运行的状态，发布结果与详细信息保留在提示和服务记录中。整机 CPU、内存和磁盘超过现有告警阈值时，数值与进度条统一标红；离线或缺少采集数据时显示“—”。

整机资源区属于项目共享资源，选择服务器只改变指标，不改变环境服务列表及版本。CPU 达到 85% / 95%、内存达到 80% / 90%、磁盘达到 80% / 90% 分别进入提醒 / 严重级别，两级均以红色数值和进度条提示，悬浮或键盘聚焦可查看文字说明、剩余磁盘容量和采集时间；离线或缺少数据时不把历史指标展示为当前指标。

界面使用 shadcn/ui 的 Radix 组件体系：Select / Combobox、Field、Accordion、Table + TanStack Table、Sheet、ScrollArea 和 Sonner。通知组件在构建时接入页面 CSP nonce，不放宽样式安全策略。旧的环境与服务、部署发布和配置详情地址仍兼容。

默认采用浅色玻璃主题，材质样式集中在 `web/src/styles/solid-glass.css`，保留现有 Radix 组件、布局和操作逻辑。主题参考 [Solid Glass](https://github.com/deeplethe/solid-glass)，已适配开关及页签的 Radix 状态；上游 [MIT 许可](web/public/third-party/solid-glass-LICENSE.txt)随构建分发。主题无额外运行依赖或外部字体请求。

材质通过冷灰底色、浅色面板、白色边缘高光与分层投影呈现；页签和进度槽使用凹面层次。模糊仅用于卡片、侧栏、顶部与浮层，表格、日志和嵌套卡片使用稳定底色。触摸设备关闭常驻面板模糊，不支持模糊或系统要求减少透明效果时使用实色底面，仍保留边缘和投影层次，同时保留键盘焦点、危险操作颜色与高对比度模式。回退主题时移除 `web/src/main.jsx` 中的主题导入并重新构建即可。

所有 UI 开发必须遵守 [AGENTS.md](AGENTS.md) 中的 shadcn/ui 组件规范，统一复用 `web/src/components/ui/`，新增组件以 [官方文档](https://ui.shadcn.com/docs) 为准。

项目和任务地址可以收藏、刷新、直接打开，例如 `/#/projects/<项目ID>/tasks?environment=<环境ID>&task=<任务ID>`。切换项目会关闭旧事件连接和弹窗，丢弃旧请求的迟到结果。

服务器页的 CPU、内存、磁盘指标属于整台机器，部署目标、容器信息及发布记录按项目返回。同一服务器上的多个项目共用串行任务队列；不同服务器可并行。仅无本项目部署目标引用的服务器可解除绑定，解除绑定不撤销 Agent、不停止容器。系统管理中的「服务器管理」负责全局接入与撤销；「共享凭证」「操作记录」仍由现有管理员统一管理。本版没有项目成员权限。

### 仓库下载与发布分支

仓库创建后显示独立下载密码、浏览器及 API 下载地址。代码仓库的「刷新仓库信息」只查询分支，不预先打包源码。原下载地址保留原兼容分支，新仓库使用识别到的默认分支；切换发布分支不改变这些地址的行为。

发布时选择分支及最近 100 条记录中的具体 commit，默认预选当前部署位置正在运行的来源分支。首次发布兼容原环境分支，新服务使用远端默认分支。切换分支清空旧提交；刷新后原提交已不在列表中时必须重新选择。分支已删除的历史版本仍可从中心档案恢复。

下载密码随机生成，只保存哈希，仅在创建和重置时显示。重置立即使旧密码失效，已开始发送的内容无法收回；停用仓库会阻止新下载与新发布。公开仓库可以不选 Gitee 凭证。Gitee 凭证仅在中心加密保存，不交给 Agent。

创建发布任务时固定仓库地址、所选分支、完整 commit 和部署配置，保留对应 Git 对象；ZIP 校验并归档后才下发 Agent。重复提交相同幂等请求返回原任务，参数不同则返回冲突。配置修改和远端分支变化不会把已创建任务替换为其他提交。

项目范围 API 见 [工作空间接口说明](examples/workspaces-api.md)。旧浏览器和 Jenkins 下载 URL、下载密码格式保持兼容。

## 集中部署与 Jenkins 并行

服务器接入后直接用于部署，无需选择或切换管理方式。平台只操作自己创建且归属匹配的目标，不接管已有外部容器。


资源归属检查同时在中心和 Agent 执行；已有目标不能直接改变所属服务器或服务。Agent 不自动接管其他容器。构建目录、容器、镜像、网络、卷和 Maven 缓存与 Jenkins 分开管理。

Java 发布依次完成 ZIP 校验、Maven 编译、镜像构建、更新目标容器和 HTTP 健康检查；前端则安装锁定依赖、执行构建、切换静态版本目录并验证共用 Nginx 返回的版本。失败时尝试恢复上一成功版本；首次发布没有基线时明确报告无法回退。前端没有重启操作，不修改或重启共用 Nginx。

中心保留所有成功版本的源码 ZIP 与配置，管理员可以手动清理非受保护版本。Agent 1.5.1 起按每个部署位置成功发布链的末尾 N 个节点保留本机产物，默认 2 个；成功回退新增节点，重启和失败不计入。更早版本按中心源码与历史配置重建。管理员在「服务器管理 → 存储策略」按服务器设置版本数和平台专用构建缓存额度（默认 2 GiB），Agent 空闲执行并上报结果。清理本机缓存不会删除中心档案。详见 [存储策略](examples/storage-policy-20261017.md) 与 [源码版本档案](examples/source-archives-20261015.md)。

Agent 1.6.0 支持为 Java 部署位置配置固定 Docker 网络别名。名字随发布、重启和历史回退保留，服务间调用地址可以写入对应环境的源码配置。详见 [固定服务网络别名](examples/fixed-network-alias.md)。

Agent 1.4.2 支持有容量上限的完整源码 ZIP 缓存：最多 4 份、128 MiB，复用前核验当前任务授权及 SHA-256，Java 与前端均适用。完成任务后立即领取下一项，默认 Agent CPU 上限提高至 0.5 核；构建与健康检查继续完整执行。配置与运行说明见 [部署指南](examples/deployment-guide.md)，前后耗时与升级恢复见 [性能验收记录](examples/deployment-performance-20261016.md)。

中心分别展示 Agent 在线状态、任务结果和业务健康情况。超过 60 秒无心跳显示失联，保留最后采集时间。日志保存发生时间和接收时间，支持断线补报与阶段耗时展示。Agent 只需出站 HTTPS，无需公网入站端口。

Agent 挂载宿主机 Docker Socket，具备近似宿主机管理员的容器管理权限。构建容器不挂载 Docker Socket，但 Maven 插件会执行，因此只发布受信任的项目。

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

## 升级到项目工作空间

升级前暂停提交新任务、等待 Agent 任务结束，停止中心，备份**整个数据卷、Agent 数据目录、原镜像及 Compose 配置**。升级只迁移中心数据，不发布服务、不修改现有业务容器。

首次启动按事务执行工作空间迁移，并记录 `workspaceVersion` 防止重复迁移；部署数据版本提升为 2，使旧中心拒绝启动。迁移前另存 `workspace-backup-*/state.sqlite` 与 `master.key` 作为配置诊断副本；该副本不包含任务日志和源码包，不能代替完整数据卷备份。

- 单个项目引用的仓库归入该项目；未被引用的仓库进入自动创建的“历史源码”项目。
- 多个项目共用的旧仓库保留在“历史源码”项目，原下载 URL 和密码继续使用；各项目获得独立配置副本，并更新环境服务引用。副本需重置密码后才能获得其独立下载凭据。
- 由现有部署目标补齐项目与服务器绑定；旧环境的仓库/分支映射为每个服务的环境源码配置。
- 保留项目、目标、Agent 身份、容器名称、任务和日志 ID。未完成任务继续使用原源码选择；已有源码包不重新生成。
- 项目首页展示迁移摘要。旧缓存目录不会自动删除，新同步使用按地址和分支隔离的目录。

回退必须成对恢复升级前完整数据卷与原镜像。不要将旧镜像直接连到已迁移数据卷。详细步骤见 [运维指南](examples/deployment-guide.md)。

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

需要 Node.js 24+、pnpm 11.25.0、Git 和 `tar`。首次执行 `pnpm install --frozen-lockfile` 安装前端构建依赖。`pnpm start` 自动构建界面和 Agent 安装包，再启动中心；直接运行 `node src/server.mjs` 前先执行 `pnpm build`。

前端源码位于 `web/`，构建输出为 `dist/web/`（不提交 Git），组件清单为 `components.json`。旧 `public/` 页面已替换。生产运行直接由中心提供同源静态资源，不依赖 CDN；界面构建细节见 [前端维护说明](examples/frontend-guide.md)。

PowerShell：

```powershell
$env:COOKIE_SECURE = 'false'
$env:PUBLIC_ORIGIN = 'http://localhost:8080'
pnpm start
```

Linux/macOS：

```bash
COOKIE_SECURE=false PUBLIC_ORIGIN=http://localhost:8080 pnpm start
```

验证命令：

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:ui
pnpm run build
pnpm test
pnpm run bundle:agent
pnpm run test:browser
pnpm run test:deploy-browser
pnpm run test:docker
docker compose config --quiet
```

`check` 执行中心/Agent 语法和组件类型检查；`check:ui` 额外检查前端格式；`pnpm test` 使用临时本地数据、Git 仓库及测试凭证，覆盖源码鉴权、会话/CSRF、SQLite 迁移、任务调度、恢复和资源归属检查等逻辑，不连接真实 Gitee 项目或业务服务器。

两个浏览器命令需要 Chrome/Chromium/Edge，可通过 `BROWSER_PATH` 指定路径。原浏览器测试验证源码管理流程；部署浏览器测试使用真实中心和模拟 Agent 回报验证管理配置、资源归属隔离、发布/回退页面、SSE 日志和移动布局。截图保存到被 Git 忽略的 `.test-artifacts`。

`test:docker` 是单独执行的真实集成验收，需要可用的 **Linux Docker 引擎**、镜像拉取和 Maven 依赖访问能力。它使用本地 Java 演示项目、临时中心与两个 Agent，创建独立容器和网络，验证编译、发布、重启、失败回退及资源归属隔离；不会操作现有业务容器。输出报告位于 `.test-artifacts/docker-verification.json`。运行命令和验收方法不表示当前环境已经验收或上线，结果以实际命令输出与报告为准。
