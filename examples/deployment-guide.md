# 集中部署平台运维指南

> 现行范围（2026-10-25）：本指南描述旧独立中心的页面、Compose 和数据卷，不能直接用于当前 T3 工作台的启动、升级或回滚。旧 Jenkins／脚本直取源码及独立下载口令已从当前代码退役；Git 凭证、固定源码包、历史档案及 Agent 安装和任务取包保留。当前入口与验证见[部署核心适配记录](../docs/runtime-modules.md#main-部署核心适配2026-10-25)，发行及程序回滚以[当前验证发行](agent-demo-t3-deployment.md#当前验证发行)为准；程序回滚不得覆盖发布后新增业务数据。

下文 A / B 和 Jenkins 并行部署是旧环境背景，不表示已核实当前服务器状态，也不表示本次已停止、删除或迁移外部 Jenkins 服务。历史操作与验收分别见 [Java 操作手册](java-operator-manual.md)和[2026-10-15 验收清单](release-checklist-20261015.md)。

## 接入顺序

1. 部署中心，设置实际 HTTPS `PUBLIC_ORIGIN`、安全 Cookie 和持久数据卷。
2. 登录后创建或进入项目。新项目默认有“测试”和“生产”两个环境；在「代码仓库」添加仓库和凭证，自动识别默认分支。
3. 在项目的「服务器」选择「接入新服务器」，或「绑定已接入服务器」。接入后直接用于平台部署，不再选择管理方式。
4. 新接入时复制生成的命令，在对应 Linux 服务器执行。服务器须已有 Docker Engine、Docker Compose、curl、tar，并能访问中心和镜像/软件包源。
5. 返回项目确认服务器在线、采集时间和整机资源指标。同一服务器可绑定多个项目，无需重复安装 Agent。
6. 进入「环境与服务」创建 Java 或前端静态服务，选择顶部环境，逐个服务配置仓库和发布分支；再进入「部署发布」创建目标。前端共用现有 Docker Nginx，首次目录挂载、Node 构建配置和 Agent 升级步骤见 [前端静态站点部署](static-sites.md)。

项目内解除绑定只适用于没有本项目部署目标引用的服务器，不停止容器。撤销 Agent 接入需到系统管理的「服务器总览」，会影响共享它的全部项目。

安装命令下载 `/agent/install.sh` 与 `/agent/bundle.tar.gz`，在目标机构建 `cmr-agent:local` 并启动 `cmr-agent` 容器。注册令牌有效期 15 分钟，只能使用一次；注册后换为服务器专属凭据，原令牌文件自动删除。不要把安装命令、`identity.json` 或备份上传到公开仓库。

Agent 默认目录为 `/opt/cmr-agent`，宿主机和 Agent 容器内必须使用相同绝对路径，便于宿主机 Docker 挂载构建目录。安装脚本发现目录或同名容器已存在会停止，不覆盖身份。安装失败时先查看错误与现有目录，不通过删除数据目录来强行重装。

```bash
docker logs --tail 100 cmr-agent
docker inspect cmr-agent --format '{{.State.Status}}'
```

Agent 不开放入站服务，通过出站 HTTPS 长轮询领取任务、每 10 秒回报心跳。安装时挂载 Docker Socket，拥有近似宿主机管理员的容器管理能力；中心和 Agent 再按目标归属限制具体操作。Agent 默认限制为 256 MiB 内存、384 MiB 内存加交换空间、0.5 核 CPU，编译容器和业务容器资源分别配置。

Agent 1.4.2 在独立的 `source-cache/` 目录复用已校验的完整 ZIP，按中心、项目、仓库、提交和 SHA-256 隔离，最多保留最近使用的 4 份、合计 128 MiB。每次命中仍向中心核验当前任务权限，并重新校验本机文件；损坏缓存重新下载原固定包。中心不支持 HEAD 时沿用完整下载。该缓存不挂载进构建容器，不影响中心成功版本的永久保留或本机部署产物的保留规则。

任务完成并补报结果后立即领取下一项，仍保证同一服务器串行构建。中心只在所属节点任务就绪或结束时唤醒领取请求，避免配置保存、源码尚未就绪时提前返回空任务并触发重试等待。日志分别记录下载或缓存复用、解压及权限准备耗时，便于区分网络、构建和应用启动瓶颈。2 核测试机可按实际余量将 Java 构建设为 1.5 核、1024 MiB；不要把该配置套用于所有小规格服务器。

### Docker 镜像源返回 HTML 时

若安装时出现 `encountered unknown type text/html`，检查宿主机 Docker 镜像代理是否返回网页。2026-10-15 在 B 遇到此情况：保留全局 Docker 配置，从 Docker Official Images 的 Amazon ECR Public 镜像源预拉取基础镜像并赋予原标签后，原安装脚本构建成功。

```bash
docker pull public.ecr.aws/docker/library/node:24-alpine
docker tag public.ecr.aws/docker/library/node:24-alpine node:24-alpine
docker pull public.ecr.aws/docker/library/docker:29-cli
docker tag public.ecr.aws/docker/library/docker:29-cli docker:29-cli
```

这只是准备安装依赖，不会安装 Agent，也不替换运行中的容器。需要网络能访问 ECR Public 以及 Alpine 包源。若安装已经创建了 Agent 目录后才失败，不要直接删除目录重跑：先核对是否已有身份/容器，确认只是本次未完成的新安装后再由运维清理或恢复。注册口令到期需在中心重新生成接入记录。

## 与现有服务并行

平台不登记或采集外部容器，也不根据容器名称接管服务。创建部署目标时只选择环境、服务和服务器，再填写构建与运行配置。已有 Jenkins 任务继续管理原有容器。

升级时，旧版监控服务器保留身份并开放部署能力；旧外部目标停止下发和采集，退出当前目标列表，历史数据保留，不转换为可部署目标。需要部署同一业务时另建平台目标并隔离端口与业务数据。

主机资源和平台已部署服务的健康状态仍持续上报。服务器失联只代表暂时没有心跳，不等于业务停止。撤销接入不会停止现有容器。

## 独立验证首次发布

使用有独立资源的 Linux Docker 环境，避免在当前承载 Jenkins、中间件和四个 Java 服务的小规格测试机再叠加编译与业务副本。

仓库内的 [Java 演示项目](demo-java) 不连接数据库或消息队列，适合首次验证。可将 `examples/demo-java/` 的内容作为独立 Gitee 仓库根目录，配置为中心源码项目；真实 Docker 集成测试则直接使用本地源码，不需要创建远程仓库。

在中心创建演示项目并添加演示源码仓库。在「环境与服务」新增服务，Maven 模块填写 `.`，选测试环境并为服务配置仓库和发布分支。接入平台管理服务器，在「部署发布」创建目标，按下表配置：

| 配置项 | 演示值 |
| --- | --- |
| Maven 模块 | `.` |
| JAR 产物路径 | `target/demo.jar` |
| 构建镜像 | `maven:3.9.9-eclipse-temurin-8` |
| 运行镜像 | `eclipse-temurin:8-jre` |
| JVM 参数，每行一个 | `-Xms32m`、`-Xmx96m` |
| Spring Profile | 留空 |
| 应用参数 | 留空 |
| 端口映射 | `127.0.0.1:18081:18081`，先确认宿主机端口空闲 |
| 已有 Docker 网络 | 留空，使用独立平台网络 |
| 持久化卷 | 留空 |
| 构建资源 | 1 核、768 MB |
| 运行资源 | 0.5 核、192 MB |
| 健康检查 | 容器端口 `18081`，路径 `/health`，状态码 `200` |
| 响应需包含 | `cmr-demo-ready` |
| 健康检查等待 / 间隔 | 45 秒 / 2 秒 |

点击「发布最新源码」，确认固定源码版本后依次完成下载、编译、容器更新、健康检查。阶段耗时及日志位于「发布记录」。发布成功后可在目标服务器访问：

```bash
curl --fail http://127.0.0.1:18081/health
```

多模块项目将服务模块改为实际名称，产物路径改为 `模块/target/实际文件.jar`，也可使用只在文件名部分出现的单个 `*`，且必须匹配唯一 JAR。Spring 服务按源码设置 Profile、端口、路径和响应校验；业务配置仍由源码 YAML 提供，不要求改为环境变量。

已有网络需提前创建。数据卷只允许平台命名卷，挂载到 `/app/` 下的子目录；例如 `logs:/app/logs`，系统为卷名添加目标前缀，不允许任意宿主机路径。不要填写 Jenkins 目录、外部卷或原业务容器名称来尝试复用资源。

**源码 ZIP 上限：** 部署 Agent 第一版最多 64 MiB ZIP、32 MiB 单个解压文件、1 GiB 总解压体积。Agent 超限会失败，调高中心 `MAX_ARCHIVE_MB` 不能绕过 Agent 限制。全程仍传输完整 ZIP，不采用哈希增量分发。

演示通过后再安排真实项目副本，并分别隔离 MySQL 数据库、Redis 数据空间、RabbitMQ vhost、MinIO bucket 及会访问外部设备或定时执行的业务功能，避免副本修改原数据或争抢消息。

## 失败、回退与断线核验

- **编译失败**：修改演示 Java 为无效代码并发布，应在构建阶段失败，当前运行容器保持原版本。
- **健康检查失败**：先保留一次成功发布，在演示目标应用参数中增加 `--unhealthy` 后发布。演示服务返回 503，应报告发布失败并恢复上一个健康版本；同时检查单独的回退结果。
- **手动回退**：已有多个成功版本时，在目标「回退版本」选择历史版本。缓存存在则恢复产物，否则从中心原 ZIP 按历史配置重建，并再次检查健康。成功回退新增发布节点；Agent 默认只保留成功发布链的最后两个节点对应的本机产物，中心成功档案全部保留。详见 [存储策略](storage-policy-20261017.md)。
- **首次发布失败**：没有成功基线时明确报告无法恢复旧版本，不能显示成回退成功。
- **中心暂时断线**：Agent 继续已领取任务，日志先写入本地，连接恢复后补报。不要因为中心没收到结果而手动重复部署。
- **Agent 重启**：先核对本地任务与容器；编译中断报告中断，进入部署的任务核验实际版本后继续健康检查或回退，不从头重复执行。
- **同机任务排队**：同一服务器只执行一个任务；目标发布、重启与回退共用执行队列，不并发更新同一服务。

源码 ZIP、解压目录和构建中间产物在任务结束后清理，任务日志、身份和成功版本记录持久化。中心保留固定任务源码与日志，需监控磁盘，不要手动删除仍可能被下载或恢复的任务文件。平台不执行全局 `docker system prune`。

## 升级、备份与恢复

### 中心

升级前暂停提交新任务，等待 Agent 当前任务结束，记录当前镜像 ID、Git 版本、Compose 配置及 `.env`。已有源码准备和 Agent 取包也须排空；仅暂停中心升级窗口，不修改外部系统。

以下备份示例在中心项目目录的 Linux Shell 执行，自动识别 Compose 挂载到 `/data` 的命名卷：

```bash
umask 077
cmr_container=$(docker compose ps -aq code-minification-repository)
test -n "$cmr_container"
cmr_volume=$(docker inspect "$cmr_container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
test -n "$cmr_volume"
cmr_backup_time=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
docker image tag "$(docker inspect "$cmr_container" --format '{{.Image}}')" "code-minification-repository:before-$cmr_backup_time"
docker compose stop code-minification-repository
docker run --rm --network none \
  --mount "type=volume,src=$cmr_volume,dst=/data,readonly" \
  --mount "type=bind,src=$PWD/backups,dst=/backup" \
  node:24-alpine tar -czf "/backup/center-$cmr_backup_time.tgz" -C /data .
```

先确认备份成功，再使用明确版本的代码执行 `docker compose up -d --build`。第一次从旧版升级时自动备份旧 `state.json` 和 `master.key`，完成 SQLite 迁移；以后 **`state.sqlite` 是权威数据源，旧 `state.json` 不再更新**。不要手改旧 JSON 期待配置生效。

升级后检查 `/healthz`、管理员登录、源码项目数量、已授权历史档案的 SHA-256 响应及 Agent 在线状态，再在独立环境发布演示项目。旧 Jenkins/脚本下载及独立口令已移除，不再作为接入方式。

升级失败时：

1. 停止新中心，保留故障卷用于排查。
2. 创建一个新的恢复数据卷，将**升级前整卷备份**完整解压进去，保留所有者与权限。
3. 使用保存的原镜像版本，并在 Compose 覆盖配置中让 `repository-data` 指向恢复卷；核对配置后启动。
4. 验证登录、固定源码档案及 Agent 取包，再恢复访问。

不要直接将旧镜像启动在升级后的原卷上，也不要用 `docker compose down -v` 清空故障卷。旧镜像可能只读取已过时的 `state.json`。数据库损坏、密钥丢失或版本不支持应停止启动并恢复备份，不能以空数据替代。中心至少需要一起保留 `state.sqlite`、`master.key` 和 `deployments/`；推荐始终备份整个数据卷。

### Agent

等待该服务器所有任务结束后，停止 `cmr-agent`，备份整个 `/opt/cmr-agent`，保存原镜像 ID、挂载与环境配置。使用明确版本的 Agent 程序重新构建镜像，再按原挂载和中心地址替换容器。不要重新执行一次性安装脚本覆盖旧目录，也不要复制其他服务器的 `identity.json`。

Agent 更新失败时，以原镜像、原目录和原环境配置恢复。只替换 Agent 不会删除业务容器；仍须保持同一目录绝对路径和身份，以便核对任务及历史版本。中心与 Agent 自身升级不通过业务发布任务执行。

## 验证命令与结果

在仓库根目录执行：

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
```

需要 Node.js 24+ 与 pnpm 11.25.0；前端构建产物位于 `dist/web`，直接启动中心前必须完成构建。`check` 与 `check:ui` 检查语法、类型和格式，`test` 验证临时数据下的逻辑；`bundle:agent` 生成只含程序文件的安装包。浏览器测试需要 Chrome、Chromium 或 Edge，可用 `BROWSER_PATH` 指定；截图位于 `.test-artifacts`。部署浏览器测试的 Agent 回报是模拟数据，不等同于真实 Docker 验收。

`test:docker` 需要开发机可用的 Linux Docker 引擎、镜像下载和 Maven 依赖网络，单独启动临时中心、两个 Agent 及演示 Java 容器。脚本仅使用本次独立标识的 Docker 资源，验证完整 ZIP、真实编译、发布、健康失败回退、手动回退、Agent 重启及资源归属检查。结果写入 `.test-artifacts/docker-verification.json`；以本次退出码、任务结果与日志判断是否通过。

外部 Jenkins 服务是否继续运行或迁移需按实际环境另行确认；其流水线不能再依赖已退役的中心直取源码接口。本文不授权停止或接管这些服务，历史运行基线与记录仍应保留。

## 项目工作空间升级核验

升级前停止中心并保存完整数据卷、Agent 目录、Compose 配置与原镜像。中心启动时会额外保存配置备份 `workspace-backup-*`，执行事务迁移并记录版本标记。配置备份不包含任务源码和日志，不能用于代替整卷恢复。

升级后逐项检查：

1. 项目首页显示原项目，环境、服务、目标和发布历史数量正确；从现有目标生成服务器绑定。
2. 核对旧下载路由不再提供文件、不再发放口令；通过已授权的固定版本档案下载校验提交和 SHA-256。
3. 原 Agent 保持身份，无需重装；服务器管理方式、原容器名称及运行状态保持不变。
4. 在各项目「环境与服务」确认仓库和分支。共用仓库原记录在“历史源码”，各项目持有独立副本；副本不再创建独立下载口令。
5. 只在独立测试环境验证新发布、回退和多项目共享服务器排队。旧任务和源码包仍通过原任务 ID 读取。

独立 Docker 验收脚本已经包含共享 Agent 的跨项目串行发布场景。执行 `pnpm run test:docker` 需要 Linux Docker 引擎及镜像/Maven 依赖网络访问能力。没有 Docker 时退出并报告环境错误，不代表验收通过。回退恢复升级前完整数据卷及原镜像，保留失败数据用于排查。


## shadcn/ui 界面升级

本次界面使用 React + Vite + Tailwind CSS，官方 Radix 版 shadcn/ui 组件源码随仓库保存。中心与 Agent 的运行协议、SQLite 数据位置及部署任务取包保持原有约定。Dockerfile 增加前端构建阶段，需要访问 npm 注册表，最终运行镜像只包含静态界面和中心/Agent 程序。

本地部署步骤为 `pnpm install --frozen-lockfile` → `pnpm build` → `node src/server.mjs`；生产推荐构建镜像后按原整卷备份流程升级。不要只复制后端代码而遗漏 `dist/web`。界面从同源 `/assets/` 加载，反向代理需将 `/`、`/assets/` 和 `/api/` 交给中心，并继续支持 SSE。

中心每次 HTML 响应生成随机样式 nonce，仅授权 Radix 弹窗滚动锁样式；脚本仍限制为同源，未开放 `unsafe-inline` 或 `unsafe-eval`。反向代理不要缓存 HTML 或改写 CSP。键盘 Tab/Escape、手机抽屉导航、任务深链接和迟到响应隔离由浏览器测试覆盖。
