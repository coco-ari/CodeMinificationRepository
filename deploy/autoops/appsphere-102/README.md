# appSphere（102）部署节点

Ubuntu 24.04，4 核、4 GB 内存、60 GB 磁盘；`ubuntu@10.2.2.175:22`，地址由 DHCP 分配。密码不记录在仓库。首次 SSH 主机公钥指纹为 `SHA256:6xXjfpQG1HL1Q0P38DioBMbHWYlCTE0rJ07F5LiyKqg`。

平台节点名称 `appSphere（102）`，ID `4ece1e53-3eea-493d-9eb8-7564a91751ee`，Agent 版本 `1.6.0`。用户明确选择暂不绑定，因此不授予项目准入、不绑定环境，也没有部署业务应用。原用户创建的“企业版agent”待接入记录保留，本次试装产生的无绑定临时节点已通过管理接口删除。

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

后续由管理员执行“平台节点 → 项目准入”，再由项目管理员绑定目标环境。DHCP 地址变化不影响 Agent 主动连接中心，但影响 SSH 运维；建议在 DHCP 服务端预留地址，当前未修改网络配置。
