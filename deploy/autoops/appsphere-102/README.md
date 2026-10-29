# appSphere（102）部署节点

Ubuntu 24.04，4 核、4 GB 内存、60 GB 磁盘；`ubuntu@10.2.2.175:22`，地址由 DHCP 分配。密码不记录在仓库。首次 SSH 主机公钥指纹为 `SHA256:6xXjfpQG1HL1Q0P38DioBMbHWYlCTE0rJ07F5LiyKqg`。

平台节点名称 `appSphere（102）`，ID `4ece1e53-3eea-493d-9eb8-7564a91751ee`，Agent 版本 `1.6.0`。2026-10-29 20:44 按用户确认恢复为未分配的平台节点，当前没有项目授权或环境绑定，也没有部署业务应用。原用户创建的“企业版agent”待接入记录保留，本次试装产生的无绑定临时节点已通过管理接口删除。

Docker `29.1.3`、Compose `2.40.3`，来自 Ubuntu 软件包。Agent 容器 `cmr-agent`，镜像 `cmr-agent:local`；重启策略 `unless-stopped`，内存 256 MiB、交换总额 384 MiB、CPU 0.5、PID 128，日志每份 10 MiB、最多 3 份。容器按专用部署 Agent 设计挂载 Docker Socket，负责受中心授权的部署任务。

| 路径 | 用途 |
| --- | --- |
| `/opt/cmr-agent` | Agent 身份、任务和状态，升级时保留，禁止重新注册覆盖 |
| `/opt/cmr-agent-static` | 前端静态发布目录及归属标记 |
| `/opt/cmr-agent/center-ca.crt` | 中心公开 CA，供 Node TLS 使用 |
| `/usr/local/share/ca-certificates/autoops-internal-ca.crt` | 宿主机信任的中心 CA |
| `/opt/cmr-agent/README.md` | 本机运维说明 |

中心固定使用 `https://autops.abroad.besiter.com.cn`。CA 来源和指纹见 [workbench 运维说明](../workbench-101/README.md#节点接入-https-与内部-ca)。注册成功后一次性令牌文件已删除，不在日志、文档或浏览器存储中保留令牌。

```sh
sudo docker ps --filter name=cmr-agent
sudo docker logs --tail 50 cmr-agent
curl --fail https://autops.abroad.besiter.com.cn/api/agent-demo/health
```

2026-10-29 已通过真实平台注册、安装、容器运行、TLS 验证及心跳检查。HTTP 页面复制命令成功，生成地址为 HTTPS，页面脚本错误 0。没有执行业务构建或业务发布，节点在线不代表具体业务应用已部署。

节点体验更新后，由平台管理员在“平台节点 → 分配到项目／环境”一次完成项目授权和环境绑定，也可仅授权项目或暂不分配。存储设置从“配置节点”直接编辑，不要求绑定或部署。

2026-10-29 19:00 发布前核对发现该节点已有“企业版-全球／测试环境”的授权和绑定。用户随后明确要求恢复为未分配的平台节点；20:44 确认该节点无部署位置、项目无在途部署任务后，通过正式接口先解除环境绑定，再按最新授权版本撤回项目授权，两个请求均返回 HTTP 200。复查项目授权数和环境绑定数均为 0，页面显示“未分配项目”，节点持续在线，原注册时间及存储策略（版本 1、保留 2 个成功版本、构建缓存 2 GiB）未变。中心健康和 Worker 连通正常，无须重建容器。操作与验证记录保存在中心 `/opt/autoops/releases/node-ux-20261029/appsphere-unassigned.json`。

DHCP 地址变化不影响 Agent 主动连接中心，但影响 SSH 运维；建议在 DHCP 服务端预留地址，当前未修改网络配置。
