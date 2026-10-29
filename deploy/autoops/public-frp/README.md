# 公网域名与内网工作台

本批按用户要求，将 `auto.996788.xyz` 从旧测试实例切换到 workbench（101）的现有 AutoOps。公网机为 `203.195.200.164`，内网工作台为 `10.2.2.115`；数据继续由内网实例持有。保留旧服务及其数据，切换仅替换这个域名的代理目标。appSphere 保持未分配的平台节点。

## 访问链路

浏览器 HTTPS → 宝塔 Nginx → `127.0.0.1:18081` → frp WSS 隧道 → workbench `127.0.0.1:28887`。

workbench 的 frpc 主动连接 `auto.996788.xyz:443`；宝塔将专用 `/~!frp` 路径转发到公网 frps 的 `127.0.0.1:17001`。两个 frps 端口仅监听回环地址，不额外公开内网 SSH、数据库或 Docker。已有 `frps-between-days` 和其他站点沿用原配置。

frp 固定为官方 `0.71.1`，采用已有软件的独立服务实例，使用 Apache-2.0 许可证。Linux amd64 官方归档 SHA256 为 `1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803`。依据 [frp 官方发行](https://github.com/fatedier/frp/releases/tag/v0.71.1)、[鉴权配置](https://gofrp.org/en/docs/features/common/authentication/)及[证书校验](https://gofrp.org/en/docs/features/common/network/network-tls/)，客户端明确使用系统 CA 包校验公网域名证书，鉴权口令由独立文件提供。HTTPS 在宝塔终止，回环传输由本机隔离；不将私钥或口令提交仓库。

## 路径与服务

| 位置 | 配置与服务 |
| --- | --- |
| 公网机 | `/opt/frp/autoops/`；`frps-autoops.service` |
| workbench | `/opt/autoops/frp/`；`frpc-autoops.service` |
| 两端发行 | 各自目录下 `releases/frp_0.71.1_linux_amd64/`，保留官方 LICENSE |
| 两端口令 | 各自目录下 `secrets/token`，属主为专用 `autoops-frp` 用户，权限 0600 |
| 公网站点 | `/www/server/panel/vhost/nginx/auto.996788.xyz.conf` |
| 公网证书 | 宝塔原 `vhost/cert/auto.996788.xyz/`，原续签与 ACME 验证路径保留 |
| 站点回退 | `/opt/frp/autoops/backups/20261029/auto.996788.xyz.conf` |
| 内网配置备份与验收 | `/opt/autoops/releases/public-frp-20261029/` |

两端均使用 systemd、独立非登录账号、开机启动及失败自动重连。服务日志进入 journal，不记录请求正文或鉴权口令。配置文件中的路径与配套 unit 保持一致，工作目录不与已有 frp 实例混用。

隧道秘密由独立服务账号持有，不包含在现有 ubuntu 身份执行的业务备份脚本内。备份隧道配置时使用 root 将两端配置、systemd unit 与 `secrets/token` 保存到受限目录，目录 0700、秘密文件 0600；恢复时校准属主，不能把口令复制进仓库或工单。

## 应用配置与切换顺序

先备份宝塔站点和内网 `.env`，增加 WSS 接入路径但保留原业务代理。启动 frps、frpc 后，从公网机回环转发端口验证内网健康和静态资源；通过后才切换业务代理。Nginx 修改必须先 `nginx -t`，再 reload。

内网 `.env` 的 `DEPLOYMENT_PUBLIC_ORIGIN` 改为 `https://auto.996788.xyz`，清空 `DEPLOYMENT_CA_PATH`、`DEPLOYMENT_CA_SHA256`，使新生成的节点接入命令使用公网可信证书。原 appSphere 仍使用已有内网 HTTPS 地址和身份。内网 HTTP 入口保留，公网代理强制会话 Cookie 为 Secure；应用精简模式、镜像、模型和存储策略不变。确认无在途任务后，只为应用新出口变量重建 gateway 和 worker。

切换后的必要验收：域名证书、HTTP 到 HTTPS 跳转、内外网健康一致、登录及 bootstrap、原生 WebSocket、精简模式、节点安装来源、appSphere 在线且未分配。配置变更不重跑无关业务测试，也不触发业务部署或清理。

## 维护和回退

```sh
# 公网机检查独立隧道服务及回环入口。
systemctl status frps-autoops --no-pager
journalctl -u frps-autoops -n 30 --no-pager
curl --fail http://127.0.0.1:18081/api/agent-demo/health

# workbench 检查客户端及本机应用。
systemctl status frpc-autoops --no-pager
journalctl -u frpc-autoops -n 30 --no-pager
curl --fail http://127.0.0.1:28887/api/agent-demo/health
```

回退域名时，在公网机恢复上表中的站点备份，执行 `/www/server/nginx/sbin/nginx -t` 通过后 reload。内网仅恢复本批修改的出口及公开 CA 字段，先核对备份与当前差异，避免覆盖后续配置；按正常维护流程重建 gateway、worker。无需恢复数据库、旧镜像或重新注册节点。若停用本隧道，再分别 `systemctl disable --now frpc-autoops`、`frps-autoops`；保留其他 frp 实例。

## 实际结果

2026-10-29 21:16 域名代理切换完成，21:19 公网浏览器验证通过：

- 两端官方归档 SHA256 校验及 `frps/frpc verify` 通过；独立 systemd 服务运行且已启用开机启动，公网 17001、18081 只监听 `127.0.0.1`。原 `frps-between-days` 仍运行。
- 宝塔原域名证书校验通过，有效期至 2027-01-22；HTTP 返回 308 到 HTTPS，根路径进入工作台，未登录 bootstrap 返回 401。原证书续签与挑战路径未改动，本批没有执行证书续签。
- 内网与公网健康均正常，Worker 可达，实际 buildHash 一致；登录成功，Cookie 为 Secure、HttpOnly、SameSite=Strict。问答页原生 WebSocket `/api/agent-demo/t3/ws` 有 24 个发送帧、20 个接收帧，无连接或页面脚本错误。
- 重建应用前，问答运行、模型轮次、工作区更新及部署在途任务数均为 0。两个容器均取得公网节点安装来源和 `project-assistant-lite-v1`，除本批三个节点出口字段外运行环境完全一致，沿用原应用镜像标签。
- 节点目录的安装来源为 `https://auto.996788.xyz`，额外 CA 指引为空；公网安装脚本可下载，LF 和 Bash 语法通过。appSphere 保持已注册、在线、未分配，存储策略仍为版本 1、保留成功版本 2、缓存 2 GiB。

公网切换证据为 `/opt/frp/autoops/verification.json`；内网证据为 `/opt/autoops/releases/public-frp-20261029/origin-verification.json` 和 `public-verification.json`。桌面页面截图保存在本地忽略目录 `.deployment/frp-20261029/`。本批未触发模型请求、新节点注册或业务部署；未重启宿主机，不把开机启动配置检查记为实际重启验收。
