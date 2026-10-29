# 2026-10-28 Docker 部署记录

本文件记录首次安装。当前版本已更新，见 [d6dfaa76 升级记录](deployment-20261028-d6dfaa76.md)。

北京时间 2026-10-28 12:06 完成部署及恢复核对。目标 SSH 为 `ubuntu@119.136.18.187:2207`，服务器内网地址为 `10.1.16.7`。

## 当前发行

- 分支：`feat/workspace-deployment-validation`。
- 固定源码：`de1134d6c5f1614e761376cec6e9cf9edd600773`。
- 镜像：`autoops:de1134d6`，镜像摘要 `sha256:a90a0b1470147baa082316803f032d28d53c155431dc905bb3a5411f036a32b2`。
- Node 24.22.0、pnpm 11.25.0、Codex 0.159.2；T3 及原生依赖仍按仓库锁定版本。
- 入口：[项目管理](http://10.1.16.7:28887/agent-demo.html#/projects)。这是内网入口，未配置公网映射、域名或 TLS。
- CPA：`https://x.996788.xyz/v1`，默认模型 `grok-4.6`。用户明确授权复制现有客户端密钥，密钥只在 `/opt/autoops/secrets/cpa-api-key`，权限 0600，不在镜像或仓库中。
- 网关和 Worker 均健康。两个容器共用容器网络命名空间，内部 8788、8789 未发布到宿主机。

这是一套独立的新安装，只有一个管理员，没有导入演示账号、项目或原服务器的数据。首次登录从项目管理页创建项目。账号为 `admin`，初始随机密码保存在服务器 `/opt/autoops/secrets/initial-admin.json`，由运维通过 SSH 读取；密码未写入此文档。

## 路径与操作

| 路径 | 用途 |
| --- | --- |
| `/opt/autoops/compose.yaml`、`.env` | 运行编排、非秘密配置 |
| `/opt/autoops/secrets/` | CPA 凭据和管理员初始凭据，仅属主可访问 |
| `/opt/autoops/releases/de1134d6/` | 发行记录、HTTP/模型验证、备份恢复及中间件保留证明 |
| `/opt/autoops/build/de1134d6/` | 固定源码、Dockerfile、官方依赖和 SPDX 原文缓存 |
| `/srv/autoops/data/` | 完整业务数据库、附件、原生状态 |
| `/srv/autoops/backups/` | 停写后成对备份 |

```sh
cd /opt/autoops
docker compose ps
docker compose logs --tail=100 gateway worker
curl --fail http://127.0.0.1:28887/api/agent-demo/health

# 在维护窗口中执行；脚本会短暂停止服务，备份后重新启动。
/opt/autoops/scripts/backup.sh
```

容器启用 `unless-stopped`、资源限制、只读根文件系统、非 root 身份以及日志轮换。没有挂载 Docker Socket。升级、回退和重新构建遵循 [部署说明](README.md)；不得用旧数据库覆盖已经产生的新数据。

## 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 同提交 CI | [运行链路检查](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40622019486)、[质量检查](https://github.com/coco-ari/CodeMinificationRepository/actions/runs/40622019468)均成功 |
| Linux 镜像构建 | 网页、Worker、部署 Agent、客户连接包均成功；冻结锁文件未修改 |
| 发行校验 | 复用现有清单、官方原生依赖逐字节校验和隔离数据发行回归，全部通过 |
| 真实 HTTP | 健康 200、Worker 可达、管理员登录 200、账号管理及创建项目权限有效；账号 1、项目 0 |
| 真实浏览器 | 登录、项目管理页、创建项目弹窗打开/Esc 关闭通过；1440×1000 和 390×844 截图检查通过，页面脚本异常 0；未创建业务项目 |
| 模型连通性 | Worker 容器内一次 CPA Responses 请求完成，返回 `OK.`，上游报告模型 `grok-4.6-build`；这不代替完整 T3 业务轮次验收 |
| 重启与备份恢复 | 停写备份后重新启动，健康恢复，管理员完整行摘要保持；隔离恢复的 17 个 SQLite 均通过 `quick_check` |
| 原中间件保留 | MySQL、Redis、RabbitMQ、MinIO 的容器 ID、镜像、启动时间、重启次数和健康状态与部署前一致 |

首份备份为 `/srv/autoops/backups/autoops-20261028T040419Z/data-and-config.tar.gz`，SHA-256 为 `1b00629d5c53a692668500ba17aafea4dd118bded05abe0a4abbb5d032b7851a3`。恢复核验保留原生运行器的四个执行文件链接，只重建已核对的 `/usr/local/bin/codex` 目标，不跟随链接读写；首次通用解包器拒绝绝对链接的记录保留在恢复报告中。

网络准备期间仅使用临时域名解析覆盖，现已撤销。第一次构建因 GitHub 原文下载超时失败，第二次缺少单数 `generatedNotice` 引用的三份许可原文，补齐锁定原文缓存后第三次成功；旧日志均保留在 `/opt/autoops/build/`。浏览器首次项目按钮名称误写导致的辅助脚本超时未计为产品故障，按实际控件名称复验通过。

未做完整项目问答、客户电脑接入或实际业务部署任务；未配置公网访问。首次问答默认页在无项目时显示项目不可用，因此交付入口直接指向可创建项目的项目管理页。
