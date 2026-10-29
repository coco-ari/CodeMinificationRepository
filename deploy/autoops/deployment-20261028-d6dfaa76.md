# 2026-10-28 Docker 升级记录

北京时间 2026-10-28 14:44 切换，14:48 完成健康、数据与访问验证。目标为 `ubuntu@119.136.18.187:2207`，实际主机 `ruanjianbu`，内网 `10.1.16.7`。

## 当前发行

- 分支：`feat/workspace-deployment-validation`。
- 源码：`d6dfaa76f8a25aa0186e065aca617d1168eb5555`，上一版 `de1134d6c5f1614e761376cec6e9cf9edd600773`。
- 镜像：`autoops:d6dfaa76`，ID `sha256:9a0d44400fa93c8905cee08998d5b27ba35d2192b694c0afd7f5d8c30484cba5`。
- 网关和 Worker 均使用该镜像，健康且重启次数为 0。旧镜像保留。
- 入口：[项目管理](http://10.1.16.7:28887/agent-demo.html#/projects)，仍需内网访问。原管理员账号、密码、CPA 与端口配置保留。
- 配置 `/opt/autoops`、业务数据 `/srv/autoops/data`、备份 `/srv/autoops/backups`；本次证据 `/opt/autoops/releases/d6dfaa76`。

本次源代码差异仅涉及项目配置导航、配置概览、部署环境工具栏、版本来源展示、对应浏览器测试及文档，未改变后端、数据库迁移或锁文件。页面功能的完整自动回归由同提交 CI 证明；此服务器没有业务项目，本次真实页面验证限定为登录和项目目录入口。

## 构建与验证

| 检查 | 实际结果 |
| --- | --- |
| 同提交 CI | [质量检查 40643064018](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40643064018)、[完整运行检查 40643064019](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40643064019)均成功 |
| 固定源码归档 | SHA-256 `efe69d70e25584547926c6ece87801de546a72b2bb6ae6d18d3e7a0e33adb8d9` |
| Linux 构建 | 网页类型检查、网页、Worker、部署 Agent、客户连接包成功，构建退出码 0 |
| 发行检查 | 10,493 个发行文件、2,038 个官方原生文件及 21 个原生包通过校验；隔离工作区发行回归成功 |
| HTTP | 登录、健康、bootstrap、账号入口和页面均 200，Worker 可达 |
| 页面身份 | HTTP 页面与容器内 `dist/web/agent-demo.html` 同 SHA-256 `43e79070f84c4698585df4d44ed4168382df97988430356d5988c19bd5f62b17` |
| 真实浏览器 | 1440×1000、390×844 登录及项目目录通过；创建弹窗打开、Esc 关闭、焦点返回通过；页面脚本错误 0，手机宽度无横向溢出；截图已检查，未创建项目 |
| 模型 | Worker 内一次 CPA Responses 请求 HTTP 200，`grok-4.6-build` 返回 `OK`、状态 completed；不代替完整 T3 业务问答 |
| 中间件 | MySQL、Redis、RabbitMQ、MinIO 的容器 ID、镜像、启动时间、重启次数保持，全部健康 |

三次前期构建因软件源下载停滞被主动中断，退出码 130，日志分别保留为 `/opt/autoops/build/build-d6dfaa76-v1.log`、`v2.log`、`v3.log`。最终构建日志为 `build-d6dfaa76.log`。Dockerfile 将构建和运行阶段的系统依赖合并为共享基础层，APT 使用 30 秒超时和两次重试；本次构建使用宿主机网络，Compose 运行网络未改变。项目依赖继续按各自 packageManager 和冻结锁文件安装，没有升级依赖。

## 备份与原数据保留

停网关后重新确认没有会话线程及部署任务，再停止 Worker。完整备份包括业务目录、Compose、环境配置及外置秘密：

`/srv/autoops/backups/autoops-pre-d6dfaa76-20261028T064351Z/data-and-config.tar.gz`

SHA-256：`74af5aa984342d19b3faafe6dd52870b3aac20f7e4e075a942a2e251f016878e`。

备份已在隔离临时目录恢复，17 个 SQLite 均通过 `quick_check`，所有表完整行摘要与停机快照一致。隔离核验跳过四个已确认目标为 `/usr/local/bin/codex` 的原生执行符号链接；原链接仍保存在完整备份中。

启动后核对 16 个可在线读取的数据库；独占运行锁库 `t3/userdata/server-owner.sqlite` 仅作停机备份与隔离恢复核验。第一次严格全表相等检查因两张认证表各新增一条记录而返回失败，`upgrade.exit=1` 和原始报告保留。随后独立读取备份和在线数据库，确认两表原各 5 条记录逐字段保留、无修改或删除；新增两行对应同一原生会话，绑定升级前已有的 AutoOps 登录会话，时间为 `06:44:05.464Z`。其余全部被比较的表完全一致，Compose 和秘密文件摘要保持。详情见 `retention-auth-explanation.json`，不得把第一次严格比对描述为通过。

升级只更改 `.env` 的镜像标签，没有初始化账号、覆盖数据或恢复旧快照。旧镜像和备份均保留，回退仍须先保护当前增量并按部署说明核对兼容性。

## 运维收尾与边界

按精确缓存 ID 处理旧 AutoOps 构建缓存，实际回收 680.4 MB 旧构建上下文；仍被引用的缓存未被删除。中间件缓存未选中，新旧镜像、备份和源码归档保留。收尾时根分区可用约 5.2 GiB、使用率 89%；后续构建前需核对空间。

未执行真实项目创建、完整项目配置、业务发布任务或客户电脑连接验收，未新增公网入口。初始安装无项目时的问答入口限制仍存在，交付入口继续指向项目目录。配置说明及本次部署记录位于仓库 `deploy/autoops`，尚未提交或推送到 Git。
