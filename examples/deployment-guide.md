# 集中部署平台运维指南

本指南适用于第一版中心与 Agent。现有 Jenkins 继续运行，自研平台先观察已有服务，再在独立环境验证发布；正式切换需要单独安排。本指南不代表已经完成真实 Docker 验收或远程上线。

## 接入顺序

1. 按 [README](../README.md#docker-部署) 部署中心，设置实际 HTTPS `PUBLIC_ORIGIN`、安全 Cookie 和持久数据卷。
2. 原「Gitee 凭证」「项目仓库」继续管理仓库及分支。旧浏览器下载地址、项目密码与 Jenkins API 不变。
3. 在「服务器」点击「接入服务器」，填写名称。现有 Jenkins 服务器选择默认的 **仅观察**；独立验证服务器才选择 **平台管理**。
4. 复制生成的安装命令，在对应 Linux 服务器执行。服务器须已有 Docker Engine、Docker Compose、curl、tar，以及访问中心和镜像源的网络能力。
5. 安装完成后返回中心，确认服务器在线、最近采集时间及资源指标。首次 CPU 采样可能暂未有值。

安装命令下载 `/agent/install.sh` 与 `/agent/bundle.tar.gz`，在目标机构建 `cmr-agent:local` 并启动 `cmr-agent` 容器。注册令牌有效期 15 分钟，只能使用一次；注册后换为服务器专属凭据，原令牌文件自动删除。不要把安装命令、`identity.json` 或备份上传到公开仓库。

Agent 默认目录为 `/opt/cmr-agent`，宿主机和 Agent 容器内必须使用相同绝对路径，便于宿主机 Docker 挂载构建目录。安装脚本发现目录或同名容器已存在会停止，不覆盖身份。安装失败时先查看错误与现有目录，不通过删除数据目录来强行重装。

```bash
docker logs --tail 100 cmr-agent
docker inspect cmr-agent --format '{{.State.Status}}'
```

Agent 不开放入站服务，通过出站 HTTPS 长轮询领取任务、每 10 秒回报心跳。安装时挂载 Docker Socket，拥有近似宿主机管理员的容器管理能力；中心和 Agent 再按观察模式、目标归属限制具体操作。Agent 默认限制为 256 MiB 内存、384 MiB 内存加交换空间、0.25 核 CPU，编译容器和业务容器资源分别配置。

## 登记 Jenkins 管理的现有服务

1. 新建「业务项目」，例如「SOL 标准版」。
2. 在项目中新增环境，并关联正确的源码项目及分支。
3. 新增 Java 服务，填写实际 Maven 模块，例如 `brezze-api`。
4. 在「部署目标」选择环境、服务、观察服务器和 **仅观察**，填写准确的现有容器名称。
5. 等待心跳后，核对运行状态、健康状态、重启次数和镜像信息。

可在宿主机使用只读命令核对名称：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

观察目标的发布、重启、回退按钮不可用，两端接口也会拒绝这些操作。目标的管理方式、服务器和所属服务不能直接编辑转换；平台不会根据名称接管已有容器。不要为了显示更多数据修改现有业务容器、健康检查或 Jenkins 任务。

主机失联表示中心暂时收不到消息，页面保留最后的状态和采集时间；不能据此判断业务停止。撤销服务器接入会使其后续认证失败，不停止现有业务容器，也不等同于取消正在运行的本地任务。

## 独立验证首次发布

使用有独立资源的 Linux Docker 环境，避免在当前承载 Jenkins、中间件和四个 Java 服务的小规格测试机再叠加编译与业务副本。

仓库内的 [Java 演示项目](demo-java) 不连接数据库或消息队列，适合首次验证。可将 `examples/demo-java/` 的内容作为独立 Gitee 仓库根目录，配置为中心源码项目；真实 Docker 集成测试则直接使用本地源码，不需要创建远程仓库。

在中心建立演示业务项目、环境及服务，Maven 模块填写 `.`。接入独立服务器并选择平台管理，创建部署目标，按下表配置：

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

**源码 ZIP 上限不同：** 原源码/Jenkins 下载默认允许 1024 MiB，Agent 第一版最多 64 MiB ZIP、32 MiB 单个解压文件、1 GiB 总解压体积。Agent 超限会失败，调高中心 `MAX_ARCHIVE_MB` 不能绕过 Agent 限制。全程仍传输完整 ZIP，不采用哈希增量分发。

演示通过后再安排真实项目副本，并分别隔离 MySQL 数据库、Redis 数据空间、RabbitMQ vhost、MinIO bucket 及会访问外部设备或定时执行的业务功能，避免副本修改原数据或争抢消息。

## 失败、回退与断线核验

- **编译失败**：修改演示 Java 为无效代码并发布，应在构建阶段失败，当前运行容器保持原版本。
- **健康检查失败**：先保留一次成功发布，在演示目标应用参数中增加 `--unhealthy` 后发布。演示服务返回 503，应报告发布失败并恢复上一个健康版本；同时检查单独的回退结果。
- **手动回退**：已有多个成功版本时，在目标「回退版本」选择保留的版本。回退恢复当时的镜像与配置，并再次检查健康。历史保留最近 5 个成功版本及当前回退基线。
- **首次发布失败**：没有成功基线时明确报告无法恢复旧版本，不能显示成回退成功。
- **中心暂时断线**：Agent 继续已领取任务，日志先写入本地，连接恢复后补报。不要因为中心没收到结果而手动重复部署。
- **Agent 重启**：先核对本地任务与容器；编译中断报告中断，进入部署的任务核验实际版本后继续健康检查或回退，不从头重复执行。
- **同机任务排队**：同一服务器只执行一个任务；目标发布、重启与回退共用执行队列，不并发更新同一服务。

源码 ZIP、解压目录和构建中间产物在任务结束后清理，任务日志、身份和成功版本记录持久化。中心保留固定任务源码与日志，需监控磁盘，不要手动删除仍可能被下载或恢复的任务文件。平台不执行全局 `docker system prune`。

## 升级、备份与恢复

### 中心

升级前暂停提交新任务，等待 Agent 当前任务结束，记录当前镜像 ID、Git 版本、Compose 配置及 `.env`。已有 Jenkins 若正在下载源码，也应等待下载完成；仅暂停中心升级窗口，不修改 Jenkins 配置。

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

升级后检查 `/healthz`、管理员登录、源码项目数量、原下载地址的认证及 SHA-256 响应、Agent 在线状态，再在独立环境发布演示项目。原 Jenkins 流水线无需改下载地址和凭据；确认其正常构建发布属于上线验收的一部分。

升级失败时：

1. 停止新中心，保留故障卷用于排查。
2. 创建一个新的恢复数据卷，将**升级前整卷备份**完整解压进去，保留所有者与权限。
3. 使用保存的原镜像版本，并在 Compose 覆盖配置中让 `repository-data` 指向恢复卷；核对配置后启动。
4. 验证登录与原下载入口，再恢复访问。

不要直接将旧镜像启动在升级后的原卷上，也不要用 `docker compose down -v` 清空故障卷。旧镜像可能只读取已过时的 `state.json`。数据库损坏、密钥丢失或版本不支持应停止启动并恢复备份，不能以空数据替代。中心至少需要一起保留 `state.sqlite`、`master.key` 和 `deployments/`；推荐始终备份整个数据卷。

### Agent

等待该服务器所有任务结束后，停止 `cmr-agent`，备份整个 `/opt/cmr-agent`，保存原镜像 ID、挂载与环境配置。使用明确版本的 Agent 程序重新构建镜像，再按原挂载和中心地址替换容器。不要重新执行一次性安装脚本覆盖旧目录，也不要复制其他服务器的 `identity.json`。

Agent 更新失败时，以原镜像、原目录和原环境配置恢复。只替换 Agent 不会删除业务容器；仍须保持同一目录绝对路径和身份，以便核对任务及历史版本。中心与 Agent 自身升级不通过业务发布任务执行。

## 验证命令与结果

在仓库根目录执行：

```bash
npm run check
npm test
npm run bundle:agent
npm run test:browser
npm run test:deploy-browser
npm run test:docker
```

前两项检查语法和临时数据下的逻辑；`bundle:agent` 生成只含程序文件的安装包。浏览器测试需要 Chrome、Chromium 或 Edge，可用 `BROWSER_PATH` 指定；截图位于 `.test-artifacts`。部署浏览器测试的 Agent 回报是模拟数据，不等同于真实 Docker 验收。

`test:docker` 需要开发机可用的 Linux Docker 引擎、镜像下载和 Maven 依赖网络，单独启动临时中心、两个 Agent 及演示 Java 容器。脚本仅使用本次独立标识的 Docker 资源，验证完整 ZIP、真实编译、发布、健康失败回退、手动回退、Agent 重启及观察权限。结果写入 `.test-artifacts/docker-verification.json`；以本次退出码、任务结果与日志判断是否通过。

现有 Jenkins 服务继续通过原流程发布。所有验证成熟并明确安排切换后，再逐个服务转移管理归属，保留原 Jenkins 配置、运行基线和历史记录用于恢复。
