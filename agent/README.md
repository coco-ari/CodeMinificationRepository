# 服务器 Agent

Agent 主动通过 HTTPS 接入中心，不开放入站端口。Linux、Docker Engine 和 Docker Compose 必须预先安装。中心生成的安装命令会构建本目录 Docker 镜像，并把 `/opt/cmr-agent` 持久化到宿主机同一路径。

Agent 挂载 `/var/run/docker.sock`，具有近似宿主机 root 的容器管理能力。请只在受信任的内部服务器安装。仅观察模式会同时在中心和 Agent 拒绝所有部署、重启、回退及清理动作。Agent 仅检查明确登记的容器；不能把监控失联理解为业务停止。

## 接入和升级

从中心复制一次性安装命令执行。安装脚本遇到已有目录或容器会停止，避免覆盖身份。注册成功后一次性令牌自动删除，专属身份保存在目录内的 `identity.json`，不得提交到代码仓库或发送给其他服务器。

升级时等待本机发布任务完成，备份整个 Agent 目录，重新构建明确版本的 Agent 镜像，再以原挂载、环境配置替换 `cmr-agent` 容器。不要删除数据目录。中心与 Agent 自身不通过业务发布任务升级。

## 目录和隔离

- `identity.json`：中心地址、专属身份、最新管理模式及登记目标。
- `tasks/`、`events/`：任务日志、执行游标及可断点补报事件。
- `work/<任务 ID>/`：完整源码 ZIP、解压源码、JAR 及镜像构建目录。
- `cache/<业务项目 ID>/maven/`：独立 Maven 缓存，不共享 Jenkins 缓存。
- `targets/<目标 ID>/`：当前成功版本与保留的历史版本。

每个目标的容器和 Compose 项目名为 `cmr-<目标 ID>`，镜像为 `cmr/<目标 ID>:<任务 ID>`。镜像、容器、平台网络和卷均带 `io.cmr.*` 归属标签。发现同名但归属不符的资源时立即拒绝写操作。平台只清理自己拥有的过期镜像，不执行全局 prune，不清理外部网络或持久卷。

构建容器使用用户 `1000:1000`，只挂载当前源码和独立 Maven 缓存，不挂载 Docker Socket。运行容器按配置映射端口并加入网络；数据卷仅允许自动命名卷挂载到 `/app/` 子目录，不允许任意宿主机目录。

## 配置与恢复

配置包括 `module`、`artifactPath`、`buildImage`、`runtimeImage`、`jvmArgs`、`args`、`profile`、`ports`、`networks`、`volumes`、`build`、`runtime`、`health`。`artifactPath` 是源码根目录相对路径，只有文件名可使用 `*`，且必须匹配唯一 JAR。JVM 入口固定为 `java ... -jar /app/app.jar`。HTTP 就绪探针由 Java 8 编译，不要求运行镜像安装 curl。

第一版按 256 MiB Agent 内存配置限制源码 ZIP 不超过 64 MiB、单个解压文件不超过 32 MiB、总解压体积不超过 1 GiB。超限会明确失败，不跳过完整性校验。发布结束会清除本任务的源码和镜像构建目录，保留日志与回退记录。

网络断开后正在执行的任务继续运行，事件先持久化再补报。中心重启不影响业务容器。Agent 重启后先刷新授权，再检查持久化记录：编译中断会报告 `interrupted`；部署中断会核验实际版本、继续健康检查或回退，绝不从头重复发布。丢失本地版本记录时拒绝覆盖仍在运行的容器。

Linux Agent 使用 `flock` 持有工作目录的内核锁，同目录的第二个进程或容器会拒绝启动。进程退出或崩溃后锁自动释放，不依赖 PID 文件判断。Agent 镜像已包含所需工具。

正常运行必须设置 `CMR_CENTER_URL=https://中心域名`。隔离集成测试才允许显式 `CMR_ALLOW_HTTP_TEST=1` 使用 HTTP；不要在真实服务器启用。开发入口为 `node agent/main.mjs`。本机及容器内 `CMR_AGENT_DIR` 必须是相同绝对路径，否则宿主机 Docker 无法挂载 Agent 准备的源码。
