# AutoOps Docker 部署

本入口部署 `agent-demo` 网关和锁定 T3 Worker，复用现有发行打包及校验脚本。仓库根 Dockerfile 属于旧平台入口，不能用于当前工作台。

各服务器独立部署、独立数据，当前记录如下：

| 服务器 | 当前部署记录 |
| --- | --- |
| workbench（101），`10.2.2.115` | [bb068dbe 源码容量修复及运维说明](workbench-101/README.md) |
| `119.136.18.187:2207`，内网 `10.1.16.7` | [d6dfaa76 升级记录](deployment-20261028-d6dfaa76.md)，[初始部署记录](deployment-20261028.md) |

## 目录与身份

沿用目标机中间件的 `/opt` 配置、`/srv` 数据约定：

| 路径 | 用途 |
| --- | --- |
| `/opt/autoops/compose.yaml`、`.env` | 服务编排和非秘密运行配置 |
| `/opt/autoops/releases/<提交>/` | 本次源码身份、构建摘要和发行记录 |
| `/opt/autoops/build/` | 固定 Git 归档、官方依赖、构建日志 |
| `/opt/autoops/secrets/` | 权限为 0600 的外置凭据；不进入源码和镜像 |
| `/opt/autoops/scripts/` | 运维脚本 |
| `/srv/autoops/data/` | 完整 SQLite、WAL、附件和原生运行状态 |
| `/srv/autoops/backups/` | 停写后成对备份及校验文件 |
| `/srv/autoops/logs/` | 构建和维护记录；容器日志另由 Docker 轮换 |

容器使用 `1000:1000`。网关与 Worker 共用网络命名空间，T3 内部端口仅监听容器回环。仅网关 8787 映射为指定主机地址的 28887。应用不挂载 Docker Socket，不接管或重建已有中间件；SQLite 是应用状态的唯一存储。

## 构建

从固定提交生成 `source/`，构建上下文另提供经 SHA-256 验证的 `t3-0.1.1-linux-x64.tar.gz` 和 `codex-x86_64-unknown-linux-musl.tar.gz`。使用与 CI 一致的 Node 24.22.0、pnpm 11.25.0 及两个冻结锁文件，构建网页、Worker、客户连接包和部署 Agent 包。发行继续通过仓库现有打包脚本及原生依赖字节核验。

`spdx/` 保存上游许可证脚本已锁定的 `spdx/license-list-data@c4a7237ec8f4654e867546f9f409749300f1bf4c` 中 `json/details/` 下的 MIT、CC0-1.0、Apache-2.0、BSD-3-Clause、BSD-2-Clause、OFL-1.1、Unlicense、ISC JSON。通过原有 v3.28.0 缓存读取，不修改许可证生成器、不跳过校验；这允许目标机无法访问 GitHub 原始文件域名时继续离线生成许可清单。

```sh
docker build --build-arg SOURCE_COMMIT=<完整提交> --build-arg NODE_IMAGE=<固定摘要> -f Dockerfile -t autoops:<短提交> .
```

构建和运行阶段共用包含 Git、CA 和 libsecret 的系统基础层，避免重复下载系统依赖。APT 下载使用 30 秒超时和最多两次重试。若宿主机访问软件源正常、默认构建网络持续超时，可为上述构建命令增加 `--network=host`；此参数仅用于构建，不改变 Compose 的运行网络和端口。

首次启动须使用 `scripts/initialize-runtime-accounts.mjs` 从标准输入创建管理员，密码不得进入命令行。仅全新数据目录允许初始化；升级不能重复初始化或清空数据。

## 日常维护

```sh
cd /opt/autoops
docker compose ps
docker compose logs --tail=100 gateway worker
curl --fail http://127.0.0.1:28887/api/agent-demo/health
```

健康检查分别验证网关和 Worker；HTTP 200 不等于真实模型问答或部署业务已验收。CPA 配置需要 HTTPS 地址、真实模型目录中的默认模型和外置密钥文件。

升级前记录镜像 ID、源码提交和配置摘要，停止网关接单、排空任务，停止 Worker 后备份完整数据目录、运行配置和密钥，校验备份可读；然后使用同一固定镜像启动两个服务并验证健康、登录、核心页面及原数据保留。容器重建不删除 `/srv/autoops/data`。

回退前先保全当前数据。只有确认 SQLite 升级兼容才可直接切回旧镜像；存在不兼容迁移时，须在停写状态恢复匹配的整套数据及原生状态，不得仅覆盖单个 SQLite 文件。新系统已有写入时先保全全部增量，不自动恢复旧快照。

本次实际地址、摘要、验证结果及未测边界以服务器 `/opt/autoops/releases/<提交>/deployment.json` 和本仓库本次部署记录为准。
