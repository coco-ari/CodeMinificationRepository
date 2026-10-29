# workbench（101）Docker 运维入口

目标为 `ubuntu@10.2.2.115:22`，Ubuntu 24.04、4 核、8 GB 内存、100 GB 磁盘。部署分支 `feat/workspace-deployment-validation`。当前发行见下，初始安装及历史更新记录保留在本文后部，实际镜像与检查结果按服务器 `/opt/autoops/releases/<提交>/` 查询。

## 当前发行与产品模式

当前应用镜像为 `autoops:node-onboarding-20261029-final`，ID `sha256:708c7c0cdbe0def02a0117e9f6d8b5283da8e3957edd75a4e1642b76e6cb080f`。基于 `autoops:949f1038` 更新前端复制按钮及部署 Agent 安装包，业务后端保持该镜像版本；未包含本地尚未部署的删除回执修复。保留源码容量、分支选择、助手简化和精简产品模式。

## 节点接入 HTTPS 与内部 CA

浏览器原 HTTP 入口保留，另开放 `https://autops.abroad.besiter.com.cn`（宿主机 443 → Nginx 8443）。`.env` 必须设置 `DEPLOYMENT_PUBLIC_ORIGIN=https://autops.abroad.besiter.com.cn`，只用于节点安装命令与部署 Agent 接口，不改变原 `PUBLIC_ORIGIN` 和模型配置。

`/opt/autoops/pki` 保存内部 CA 私钥与签发材料，目录 0700、私钥 0600；`/opt/autoops/tls` 保存服务证书、私钥及公开 CA，私钥 0640、组 101，仅代理只读挂载。服务证书有效期一年，CA 十年；续期后检查 `docker compose exec -T proxy nginx -t` 并 reload。完整备份已纳入这两个目录；不得把私钥提交 Git。

公开 CA 下载地址为 `/autoops-internal-ca.crt`，SHA256 指纹 `AC:4E:A0:21:AE:2C:15:C5:FE:A8:C1:72:E3:C2:4C:C8:AA:26:D6:6F:81:DF:0E:56:48:58:09:8B:9E:AF:F2:5A`。在其他电脑首次信任前通过此独立记录核对指纹；浏览器使用 HTTPS 需将 CA 导入可信根证书。appSphere 已安装到系统信任库，Agent 使用 `NODE_EXTRA_CA_CERTS`，没有关闭 TLS 校验。

Linux 节点先安装 Docker 和 Compose，并信任中心 CA，再执行平台生成的安装命令。安装器默认沿用 `/etc/ssl/certs/ca-certificates.crt`，也可传 `--ca-file /绝对路径/ca.crt`；证书复制到 Agent 数据目录供容器使用。Shell 文件强制 LF，复制按钮复用共享 HTTP 兼容实现。发布证据和配置备份在 `/opt/autoops/releases/node-onboarding-20261029/`，构建目录同名。1 项复制浏览器测试、实际 HTTP 页面复制、Bash 语法、发行清单、HTTPS 和真实节点心跳已验证；备份脚本只做语法检查，没有额外停机全量备份。

已接入节点见 [appSphere（102）运维说明](../appsphere-102/README.md)。

## 产品模式维护

本服务器必须在 `/opt/autoops/.env` 显式设置 `AUTOOPS_DEMO_PROFILE=project-assistant-lite-v1`。Compose 共享环境变量块使用 `${AUTOOPS_DEMO_PROFILE:?请明确指定产品模式}`，网关与 Worker 均继承；遗漏或空值时配置校验直接失败，不能依赖应用未配置时的完整模式默认值。能力范围见[精简产品规范](../../../examples/agent-demo-lite-profile.md)。

确认当前问答、工作区和部署任务结束后应用配置：

```sh
cd /opt/autoops
docker compose config -q
docker compose up -d --force-recreate --wait --wait-timeout 180 gateway worker
docker compose exec -T gateway printenv AUTOOPS_DEMO_PROFILE
docker compose exec -T worker printenv AUTOOPS_DEMO_PROFILE
```

两个容器必须返回 `project-assistant-lite-v1`；还须通过已登录的 `/api/agent-demo/t3/autoops/bootstrap` 核对 `productProfile.id`，检查健康、问答、助手选择及设置搜索。仅检查 `.env` 文本不代表容器与界面已生效。配置修改前备份与本次证据位于 `/opt/autoops/releases/949f1038/profile-lite-20261029/`。

2026-10-29 实际验证：服务器与仓库 Compose 解析结果一致，缺失/空产品模式校验拒绝启动；两个运行容器及已登录 bootstrap 均为精简模式，受限能力均关闭。网关、Worker、代理健康；常规设置保留模型、权限、skill、发送行为、版本与许可证，全局搜索“移动应用、隐私政策、通知、自定义快捷键、计划模式”无对应入口。实际选择既有“测试环境问答”助手并发送一轮简短请求，收到“模式验证通过”，页面脚本错误 0。除产品模式外环境配置逐项保持一致。仅进行上述定向验证，未重建镜像或运行完整回归；验收会话保留为本次问答证据。

## 历史发行：bb068dbe 源码容量修复

运行代码 `bb068dbe9027556088de33da095ba85f8bd17571` 已提交推送，镜像 `autoops:bb068dbe`，ID `sha256:d661e8da4a8afc24e6c053021fe4c2ea53e00acdf9b0297b5843ba2ecb5c59f0`。源码归档 SHA256 `1cd7dcbd8fd4b7fcf8c03830404d7129bffe9d22ccda4236667dad902a938c9c`。包含此前已部署的分支搜索选择、助手配置简化和最新删除功能。

构建材料在 `/opt/autoops/build/bb068dbe/`，发行及真实同步证据在 `/opt/autoops/releases/bb068dbe/`。完整构建、发行文件和原生依赖校验通过；只运行 5 项容量测试及 2 项原有 Git 快照/ZIP 定向检查。网关、Worker、代理健康，实际运行额度与下表一致。

2026-10-29 15:00（北京时间）从原项目页面重试 `java-appsphere-global` 同步，任务 `8af94482-9878-4b78-863d-08b0926d08cd` 最终 `completed`，显示“工作区已更新”，页面脚本错误 0；未更改用户来源、分支或凭证。原失败任务保留为历史记录，新成功任务作为本次验收结果。没有执行真实业务删除或模型调用。

本次只更新镜像与五项容量环境变量，未升级数据库。修改前 `.env`、Compose 保存在本次发行目录，之前的镜像 `autoops:7839eedf-b439259b` 保留；旧代码仍有 64 MiB 演示额度，回退前须核对本次新增的大仓库快照，不直接覆盖当前数据。

## 源码容量配置

Git 源码同步取消旧演示额度，以下配置通过 `/opt/autoops/.env` 覆盖，由 Compose 同时传给网关和 Worker。修改后执行 `docker compose up -d --wait --wait-timeout 180`。所有值必须为正整数；单文件不得超过源码总量，源码额度不得超过 Git 导入额度，否则拒绝启动。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AUTOOPS_WORKSPACE_MAX_BYTES` | `1073741824` | 检出源码 1 GiB |
| `AUTOOPS_WORKSPACE_MAX_FILES` | `100000` | 检出源码文件数 |
| `AUTOOPS_WORKSPACE_MAX_FILE_BYTES` | `67108864` | 源码单文件 64 MiB |
| `AUTOOPS_WORKSPACE_GIT_MAX_BYTES` | `4294967296` | 含 Git 历史及临时文件的导入空间 4 GiB |
| `AUTOOPS_WORKSPACE_GIT_MAX_FILES` | `200000` | 含 Git 历史的导入文件数 |

完整 `.git` 历史保留，Git 对象包不按源码单文件上限检查；扫描分块校验文件，超限提示实际维度、已扫描值及额度。原有磁盘余量检查、路径隔离和失败不发布机制保留。手动资料上传、文档提取与问答输入仍使用各自额度，以上配置不会将整个仓库一次送入模型。本改动已通过 5 项容量测试及 2 项已有 Git 快照/ZIP 定向检查；部署结果以服务器发行记录为准。

## 历史发行：2026-10-29 最新代码与本地修改

当前网关与 Worker 统一使用 `autoops:7839eedf-b439259b`，镜像 ID 为 `sha256:9a2528c855546244e6c8235fe7ee33626230beb1982d87774d226e13274f11a8`。基线提交 `7839eedf6a0172007e42058224f7637941a6962c`，包括新增的业务对象删除与关联清理能力；同时保留未提交的工作区分支选择和助手角色选择简化。固定 Git 归档 SHA256 为 `f6a5a99bf5a20df9ae96c11643f8d80afec158ccd17ef72aacf69867eaf424b9`，本地修改归档为 `b439259b087989f7228f63cea45298c57fdc4aec59208eaeb38b5ec51d4cf88f`，镜像标签记录两者对应身份。

构建材料在 `/opt/autoops/build/7839eedf-b439259b/`，发行证据在 `/opt/autoops/releases/7839eedf-b439259b/`。完整重建网页、Worker 和配套执行包，发行与原生依赖校验、隔离发行冒烟通过。只追加运行助手保存与分支保存 2 项已有定向测试，均通过；上游删除功能的既有测试结果沿用，不重跑大范围回归。实站登录、54 个 Gitee 分支查询/选择、助手简化页面通过，无脚本错误，三个容器健康。页面 SHA256 为 `eaf3a1f12299e6f734305ce68644aef46980e52ec843bbf9d928a1a54aec2c93`。健康接口中的 sourceCommit 是锁定的 T3 提交，buildHash 只覆盖网关入口等少数文件，未覆盖完整后端；应用版本以本次镜像、源码摘要和发行清单核对。

升级前停写备份在 `/srv/autoops/backups/before-7839eedf-b439259b/`，保持 0700/0600 权限；原镜像 `autoops:3182b024-web-4cbe2318` 保留。本次有数据库升级，回退前须核对结构兼容性和升级后新写入，不直接将旧镜像与新数据库配对，也不直接覆盖当前数据。Compose、内网域名、凭证及 Worker `/tmp exec` 设置沿用。以下为历史发行记录。

## 上一批前端更新：2026-10-29 助手配置简化

当前镜像为 `autoops:3182b024-web-4cbe2318`，ID `sha256:049a695eef4d3ca01627f4ef6751754674626f0320ebfa21522fcf8fae14344b`。删除助手配置的“业务助手”角色选择及“项目助手／报告助手”候选，保留真实助手配置和既有内部身份；包含上一批源码引用选择改动。源码和网页摘要记录在 `/opt/autoops/build/assistant-role-20261029/build.json`，发行证据在 `/opt/autoops/releases/assistant-role-20261029/`。仅运行既有创建助手定向测试 1 项并构建网页，不运行大范围回归。

回退本次页面简化时，仅将 `.env` 的 `AUTOOPS_IMAGE` 改回 `autoops:3182b024-web-5772e512`，执行 `docker compose up -d --wait --wait-timeout 180` 并复核健康。数据库和 Compose 未变；不要恢复旧数据。以下为上一批记录。

## 上一批前端更新：2026-10-29 源码引用选择

当前网关和 Worker 使用 `autoops:3182b024-web-5772e512`，镜像 ID 为 `sha256:f8def02eea055ffac3cd9f25446836983a494e83c509b37e0066e13d1436f1ad`。本批是在固定基线 `3182b024` 上构建的未提交前端补丁，新增工作区分支/标签查询和选择；后端、CLI、原生依赖与数据未变更。原始部署记录在本文后部保留。

构建材料：`/opt/autoops/build/workspace-refs-5772e512/`，包括差量源码归档、源码文件摘要、网页归档、Dockerfile 和清单更新脚本。发行证据：`/opt/autoops/releases/workspace-refs-5772e512/`，包含 `build.json`、`source-files.json`、`deployment.json`、`release-verification.json`、`workspace-ref-browser.json` 及截图。源码归档摘要 `5772e512d442049722129f8b86cae4998097542d5c308873309fda295dbdaefa`；网页归档摘要 `0dd8920e6d8b05cd45352a91b58be5675c241ddae33fae60461a1c05d86ecc32`。

`Dockerfile.web` 先验证固定基础镜像的发行文件，再替换网页并重新生成网页清单项，保留所有非网页与原生依赖清单项，最后完整验证。Docker 构建使用本机镜像标签，并在构建前检查该标签 ID 等于原镜像 `sha256:a7231ae93ecb509d00673a2a90457f5ff73b13e6e4389e156f24c5d3c8870177`；不要把裸 `sha256:...` 当作 FROM 仓库名称。网关和 Worker 同步使用更新镜像，Compose 和 Worker 临时目录授权配置保持。

真实验收：54 个分支、默认 master，查询和刷新均返回 200；桌面搜索选择、窄屏键盘选择、切换引用类型清空旧值通过。无项目业务写入，页面脚本错误 0；三个容器 healthy，WebSocket 101。自动回归及已知基线失败详见仓库 `docs/validation/workspace-reference-selection.md`。

需要回退本次纯前端补丁时，将 `.env` 的 `AUTOOPS_IMAGE` 改回 `autoops:3182b024`，执行 `docker compose up -d --wait --wait-timeout 180`，复核健康即可。本次未修改数据库结构；保留当前数据，不恢复旧数据库。修改前配置保存为发行目录的 `env-before-update`，后续有其他配置变化时只修改镜像字段，不覆盖整个 `.env`。

## 访问与目录

内网域名入口：<http://autops.abroad.besiter.com.cn/>，自动跳转工作台。域名 A 记录为 `10.2.2.115`；应用 `PUBLIC_ORIGIN` 已同步为该 HTTP 域名。运维电脑 `C:\Users\taotao\.ssh\config` 已配置 `ssh workbench`（ubuntu、22 端口、原 SSH 密码），实际登录返回主机名 `workbench`。

配置期间服务器一度不可达，用户重启后恢复。重启后 SSH 主机密钥发生变化，用户明确要求接受当前主机并继续连接；旧记录已备份，新 ED25519 指纹固定为 `SHA256:/6gW+ZCmtpu5PmMBtJXM1Xo22agcea56jhRZf1d9B0o`，保存在运维电脑 `.ssh/workbench_known_hosts`。仍启用严格主机密钥检查，未禁用校验。

原 IP 入口仍保留：<http://10.2.2.115:28887/agent-demo.html#/projects>。管理员用户名 `admin`，随机初始密码仅保存在服务器 `/opt/autoops/secrets/initial-admin.json`，通过 SSH 读取；不写入源码、镜像或运维日志。

| 路径 | 用途 |
| --- | --- |
| `/opt/autoops/compose.yaml`、`.env` | 编排与非秘密配置 |
| `/opt/autoops/nginx/nginx.conf` | 内网域名反向代理、根路径跳转及 WebSocket 配置 |
| `/opt/autoops/secrets/` | CPA 密钥和初始管理员凭据，目录 0700、文件 0600 |
| `/opt/autoops/releases/<提交>/` | 固定发行、构建与验收记录 |
| `/opt/autoops/build/<提交>/` | 固定源码、Dockerfile、官方原生包及许可证缓存 |
| `/opt/autoops/scripts/` | 备份等维护脚本 |
| `/srv/autoops/data/` | SQLite、附件、原生状态，持久化绑定挂载 |
| `/srv/autoops/backups/` | 完整停写备份及校验文件，目录 0700 |
| `/srv/autoops/logs/` | 安装、构建及维护日志 |

配置、脚本与数据由 UID/GID `1000:1000` 的 ubuntu 管理，应用容器使用同一非 root 身份。Docker 自身镜像和缓存沿用 `/var/lib/docker`。安装遵循 [Docker 官方 Ubuntu 仓库方式](https://docs.docker.com/engine/install/ubuntu/)，具体软件包版本见发行目录 `docker-packages.json`。

## 运行设置

网关与 Worker 共用容器网络命名空间。网关发布 28887，Worker 的 8788/8789 仅在该命名空间内部使用。独立 Nginx 代理容器发布主机 80 至容器 8080，使用 Docker DNS 动态解析网关，支持 WebSocket 和流式响应。网关限制 768 MB/1 CPU，Worker 限制 5 GB/3 CPU，代理限制 128 MB/0.5 CPU；镜像构建的 Node 堆上限 4096 MB。使用只读根文件系统、受限临时目录、丢弃 capabilities、禁止提权，不挂载 Docker Socket。容器日志按每份 20 MB、最多 5 份轮换，重启策略为 `unless-stopped`。代理以 UID/GID `101:101` 运行，应用仍为 `1000:1000`。

代理使用官方 `nginx:1.28.3-alpine`，实际镜像固定为 `nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236`；官方镜像保留其自带许可证。采用 Nginx 提供成熟的域名及 WebSocket 代理，配置依据 [Nginx 官方文档](https://nginx.org/en/docs/http/websocket.html)。访问日志不记录查询参数。代理配置修改后执行 `docker compose exec -T proxy nginx -t`，通过后执行 `docker compose exec -T proxy nginx -s reload`。

Worker 的 `/tmp` 显式使用 `exec`：Git 的 ASKPASS 辅助脚本由应用写入临时目录并执行，Docker 默认 `noexec` 会使私有仓库读取失败。此设置经用户明确授权后生效，仅调整 Worker；仍保留 512 MB 上限、非 root、`nosuid`、`nodev` 和只读根目录。临时辅助脚本不含秘密，凭据由应用凭证服务解密后只通过子进程环境提供。

CPA 使用 `https://x.996788.xyz/v1` 和 `grok-4.6`，仅 Worker 挂载 `/opt/autoops/secrets/cpa-api-key`。用户已明确授权本服务器使用现有客户端密钥。

当前域名同时提供原内网 HTTP 和内部 CA 签发的 HTTPS；节点使用 HTTPS。服务器使用 DHCP，因此端口映射没有绑定某个固定主机地址。建议在 DHCP 服务端为本机 MAC `bc:24:11:cf:54:c8` 保留地址；本次不修改网络配置。地址变化时更新域名 A 记录，域名不变则无需修改应用 `PUBLIC_ORIGIN`。Worker 共用网关网络命名空间，维护时统一通过 Compose 处理服务。

## 常用操作

```sh
cd /opt/autoops
docker compose ps
docker compose logs --tail=100 proxy gateway worker
curl --fail http://autops.abroad.besiter.com.cn/api/agent-demo/health
curl --fail http://127.0.0.1:28887/api/agent-demo/health

# 通过 SSH 在受限终端查看初始账号，不复制到日志或工单。
cat /opt/autoops/secrets/initial-admin.json

# 手动备份会短暂停止两个服务，完成后恢复运行。
/opt/autoops/scripts/backup.sh
```

备份包括完整数据目录、Compose、环境配置与秘密，保存在带 UTC 时间的目录，附 SHA256SUMS。不自动删除历史备份，也不自动安排定时停机。升级前确认无在途任务，固定代码提交并构建，完成备份后更新 `.env` 的 `AUTOOPS_IMAGE`，执行 `docker compose up -d --wait --wait-timeout 180`，再核对实际镜像、健康、登录和关键页面。保留上一镜像供回退；回退前仍需核对数据库兼容性，不能直接用旧备份覆盖新的用户数据。

重建命令从对应构建目录执行，版本与原生包摘要由 Dockerfile 固定：

```sh
docker build --network=host \
  --build-arg SOURCE_COMMIT=3182b024bf5b5ead4b9bf01f21bc511c8a8cd89b \
  --build-arg NODE_IMAGE=docker.1ms.run/library/node@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 \
  -t autoops:3182b024 .
```

`--network=host` 只影响构建。官方原生包及 SPDX 缓存来源、校验规则见上级 Docker 部署说明。当前仓库采用开发测试验证策略，不等待 GitHub CI；必要定向回归、构建与实际健康及功能验证仍执行。

## 2026-10-29 部署结果

北京时间 10:38 验证完成。镜像 `autoops:3182b024`，ID `sha256:a7231ae93ecb509d00673a2a90457f5ff73b13e6e4389e156f24c5d3c8870177`。固定源码归档 SHA-256 `d106a5dfdd6b44c03e3f3a3a43c1d82bf43801a1da66345bc68d45caa3e853ee`。

- 官方 Docker Engine 29.9.2、Compose 5.6.1 已安装，Docker 已设为开机启动；两个应用容器均健康，已验证停写备份后的恢复启动，未重启宿主机。
- 项目目录、技能库与资料更新相关回归 60/60 通过；网页类型检查、网页、Worker、部署 Agent 和客户连接包构建通过。
- 10,497 个发行文件、2,038 个官方原生文件及 21 个原生包校验通过；隔离工作区发行回归通过。下载期间有有限重试，最终构建退出码 0，没有修改锁文件或升级应用依赖。
- 管理员登录、bootstrap、账号接口与健康均通过；一名新管理员、零项目，可创建项目和管理账号。HTTP 实际页面与镜像文件 SHA-256 相等，为 `96831a9fd4856316f7b9c8b6e6717f24411020dbd64957c9aa5ee45151f1d7b7`。
- 真实浏览器在 1440×1000 与 390×844 下通过登录、项目空态、创建弹窗开关及 Esc 后焦点恢复，无页面脚本异常和手机横向溢出，截图已检查。从用户电脑直接访问内网健康入口也通过。
- Worker 内一次 CPA Responses 请求返回 HTTP 200、`grok-4.6-build`、completed、`OK`。这只证明模型连通性，不代替完整 T3 业务问答、项目配置或实际发布验收。
- 手动备份实际执行成功，隔离解包后的 16 个 SQLite 均通过 `quick_check`，没有符号链接需要跳过。备份为 `/srv/autoops/backups/autoops-20261029T023635Z/data-and-config.tar.gz`，SHA-256 `db6ea0d96187b87baf6f42878896c2a382a6eafbb26b760bbdd3208d347d230c`。
- 收尾时磁盘约 85 GiB 可用，内存约 6 GiB 可用。旧服务器没有变更。

证据位于 `/opt/autoops/releases/3182b024`，包括 `deployment.json`、`http-smoke.json`、`model-smoke.json`、`browser-smoke.json`、`backup-verification.json` 和两张截图。构建及启动日志为 `/srv/autoops/logs/build-3182b024.log`、`start-and-verify.log`，两个对应退出码均为 0。运维说明同时保存于 `/opt/autoops/README.md`。

本次未触发远端 CI、未创建验收业务项目、未进行完整业务发布和客户电脑接入验收。仓库部署文件仍为本地未提交成果，没有提交或推送到 Git。

## 2026-10-29 内网域名配置

新增 `proxy` 服务，固定应用发行保持 `3182b024`。Compose 校验、Nginx 配置检查、备份脚本语法检查通过；三个服务均健康，域名根路径返回不带内部端口的跳转，健康入口返回 `workerReachable: true`。从运维电脑使用 `ssh workbench` 实际登录成功。

真实浏览器通过域名根路径进入、管理员登录、项目页、桌面与手机创建弹窗关闭及焦点恢复；WebSocket 握手返回 101，无页面脚本异常或横向溢出。首次检查发现跳转携带容器端口，已改为相对跳转并重验通过。本次没有发起模型请求或业务部署，不替代完整业务验收；未配置 HTTPS。

本轮备份脚本已加入 Nginx 配置、运维脚本和 README；本轮只做语法校验，未再次执行停写备份。配置前的 Compose、环境文件及说明保存在 `/opt/autoops/releases/3182b024/domain-20261029/`，该目录同时保存本轮 `browser-smoke.json`、截图和 `verification.json`。启动日志为 `/srv/autoops/logs/domain-start-20261029.log`。

## 2026-10-29 Git 凭证接入验证

通过应用管理接口为用户新建项目配置项目级凭证及仓库关联，不直接修改数据库。初次读取分支失败，定位为 Worker `/tmp` 的 `noexec` 阻止 ASKPASS 执行；用户明确授权调整并重启 Worker 后，Compose 配置校验、Worker 健康及工作台真实仓库引用读取均通过，返回 54 个分支。凭证引用关系也已通过应用接口核对。未配置工作区使用分支或触发业务部署。

修改前编排保存于 `/opt/autoops/releases/3182b024/compose-before-gitee-20261029T030906Z.yaml`，脱敏验收记录保存于同目录 `gitee-connection-verification.json`。运维说明和 Git 文件不保存真实账号密码。
