# Agent Demo 部署与恢复

> 本文保留迁移前 Demo/Bridge 的历史部署记录。T3 新模块的运行、数据导入与切换说明见 [T3 部署与恢复](../examples/agent-demo-t3-deployment.md)，模块验收状态见 [逐项覆盖表](../examples/agent-demo-t3-module-coverage.md)。切换后不要按旧命令重新启动 Bridge 操作新原生状态。

Demo 对外入口为 `http://192.168.31.157:8787/agent-demo.html`。此端口用于授权测试局域网；正式部署需要 HTTPS 和正式账号。公开演示账号为 `admin`、`lin`、`chen`，密码 `Demo123!`，与服务器登录凭据无关。

2026-10-21 15:12:42（北京时间）已部署原生会话、附件读取、运行器就绪与滚动修复：前端 `agentDemo-B-vrzzYE.js` / `agentDemo-d6XXzccF.css`，主服务 buildHash `a80c03033945e2e7707c26eb02024dc1c2fc6456d22b23822fee2aea0df34eac`。ZeroTier 入口为 `http://172.29.22.6:8787/agent-demo.html`。

部署前同时核对 SQLite 和健康接口，活动轮次为 0。本次更新主服务、Bridge、前端、Linux 生产依赖及 Bridge 服务单元，增加专用持久状态目录和主服务资料读取地址；模型、提供方及 Secret 配置未改变。主服务与 Bridge 均已启动，部署后 `liveAvailable=true`，上传源码及入口文件 SHA256 已核对。

部署清单见 [本次部署记录](../.deployment/native-session-fixes/deployment.json)。代码及原 Bridge 单元备份前缀为 `/home/tao/autoops-agent-demo/backups/20261021T071210Z-before-native-session-fixes`：代码包 `.tgz`，SQLite 一致备份 `.sqlite.gz`；已有持久运行器状态时，同批次另外保存 `-runner.tgz`。

首次部署尝试在制作备份时遇到磁盘空间不足，未切换应用代码。随后对历史 SQLite 备份进行 gzip 无损压缩并校验，释放空间后重新备份和部署；没有通过删除用户会话恢复空间。更新前应预留数据库备份、依赖暂存、解包和回退所需空间，不能只按压缩包体积估算。

本次 Linux 附件/PDF 测试 13 项通过。真实8轮网页及4轮独占故障验收通过；长测计划105轮，因CPA/Grok重复控制标记在61轮主动停止（57完成、3失败、1中断），长会话稳定性不通过。最终证据见 [验收记录](../examples/agent-demo-validation.md)。历史版本的真实 Grok 结果不能代替本次部署后的推理证据。交互原因及本地适配边界见 [源码映射](../examples/agent-demo-open-source-flows.md)。

15:27（北京时间）追加原生删除恢复补丁，主服务/前端未变，最终Bridge SHA256为 `73e90007e10531395e9c4718e45d0fa9fcd2e90508308bec6ed5a9848c71be5f`。见[部署清单](../.test-artifacts/agent-demo-native-fixes/deployment-delete.json)。两服务停止后备份同一时点SQLite及runner目录，恢复点为 `/home/tao/autoops-agent-demo/backups/20261021T072710Z-before-native-delete-fix`（`.sqlite.gz`与`.tgz`），故障验收在此最终版本运行。

## 测试机目录

| 路径或服务                                                 | 用途                                           |
| ---------------------------------------------------------- | ---------------------------------------------- |
| `/home/tao/autoops-agent-demo/runtime/current/bin/node`    | 独立 Node 24 运行环境                          |
| `/home/tao/autoops-agent-demo/app/agent-demo`              | 后端代码                                       |
| `/home/tao/autoops-agent-demo/app/dist/web`                | 构建后的静态文件                               |
| `/home/tao/autoops-agent-demo/app/node_modules`            | 在 Linux 按 lockfile 安装的生产依赖，含 PDF.js |
| `/home/tao/autoops-agent-demo/data/demo.sqlite`            | 会话、队列、草稿、文件与事件                   |
| `/home/tao/autoops-agent-demo/data/runner`                 | 原生会话绑定、用量基线及专用 Codex 状态        |
| `/home/tao/autoops-agent-demo/data/runner/codex-home`      | CPA 专用持久 CODEX_HOME，不是个人登录目录      |
| `/home/tao/autoops-agent-demo/demo.env`                    | 可选服务配置，权限应为600                      |
| `/home/tao/autoops-agent-demo/bridge.env`                  | Bridge 提供方与 Secret 引用配置，权限应为600   |
| `~/.config/systemd/user/autoops-agent-demo.service`        | 用户服务单元                                   |
| `autoops-agent-demo.service`                               | systemd 服务名                                 |
| `~/.config/systemd/user/autoops-agent-demo-bridge.service` | Bridge 用户服务单元，配置持久状态和资料 origin |
| `autoops-agent-demo-bridge.service`                        | Bridge systemd 服务名                          |

Node 24.22.0 的官方 Linux x64 压缩包已通过官方 SHA256 校验。服务启用用户 linger，SSH 断开后继续运行，开机由用户服务启动。未修改既有 8080、8081、8085、50000 等服务。

## 常用运维命令

以测试机用户执行：

```sh
systemctl --user status autoops-agent-demo --no-pager
systemctl --user status autoops-agent-demo-bridge --no-pager
journalctl --user -u autoops-agent-demo -n 100 --no-pager
journalctl --user -u autoops-agent-demo-bridge -n 100 --no-pager
curl -fsS http://127.0.0.1:8787/api/agent-demo/health
```

健康接口仅暴露服务状态、版本及构建标识，不提供凭据。主服务 `/health` 会重新探测 Bridge，不复用此前的成功状态。短暂恢复期间，已接收轮次先等待就绪，随后只提交一次运行请求；准备期可以停止。

维护重启前确认没有用户任务运行。先停止主服务和 Bridge，维护完成后先启动 Bridge，再启动主服务，并检查健康与运行器能力。服务重启仍会中断执行中的轮次；持久上下文可供用户明确继续，不能把上下文保留等同于原执行自动续跑。队列仍需要用户选择恢复。

## 本地开发与构建

需要 Node.js 24 和按仓库 lockfile 安装的依赖。后端附件解析现在依赖 `pdfjs-dist@6.4.299`，不能再只上传后端 `.mjs` 文件。开发/构建安装完整依赖；运行目录在目标 Linux 架构或一致的 Linux 构建环境中安装生产依赖，保留 lockfile，不能上传 macOS 的 `node_modules`。

```sh
pnpm install --frozen-lockfile
node agent-demo/server.mjs
pnpm dev:ui
pnpm build:ui
```

单独的 Linux 生产暂存目录使用同版本 `package.json` 和 `pnpm-lock.yaml`，执行 `pnpm install --prod --frozen-lockfile`，再随应用发布完整的生产 `node_modules`。本次依赖按该方式安装，Linux 上的 PDF 提取、损坏/加密/扫描文件与解析边界用例共 13 项通过。PDF 正文提取在独立 worker 中执行；扫描件没有文本层时返回明确状态，本轮没有引入 OCR。

Vite 已把 `/api/agent-demo` 代理到本地8787，正式构建包含 `agent-demo.html`。服务默认读取 `dist/web`。可配置 `HOST`、`PORT`、`DATA_DIR`、`STATIC_DIR`、`DEMO_PASSWORD`、`COOKIE_SECURE`。

`AGENT_BRIDGE_URL` 和 `AGENT_BRIDGE_TOKEN` 配置真实运行器连接。未连接时真实模式不可用，可控场景保持明确标记。不要把模型密钥或系统登录凭据写进前端构建变量。

## Grok CPA 接入

已按用户选择增加 CPA 提供方，使用 `https://x.996788.xyz/v1` 的 Responses 接口和 `grok-4.6`，运行器仍为 Codex App Server。独立 Linux CLI 位于 `/home/tao/autoops-agent-demo/runtime/codex-0.159.2/codex-x86_64-unknown-linux-musl`，安装包已对照 OpenAI 官方发布摘要校验。桥接代码和 `autoops-agent-demo-bridge.service` 已安装并启用，已按用户明确授权将 CPA Key 写入权限为600的专用 Secret 文件。初次 CPA 接入时曾通过三轮真实 Grok 合成验收，该结果属于旧版；本次部署健康接口返回 `liveAvailable:true`。具体配置与证据边界见 [bridge.md](bridge.md)。

私有的 `bridge.env` 注入 `AGENT_DEMO_PROVIDER=cpa`、`AGENT_DEMO_MODEL=grok-4.6`、`AGENT_DEMO_CPA_BASE_URL`、`AGENT_DEMO_CPA_API_KEY_FILE`、`AGENT_DEMO_CODEX_BINARY`、`AGENT_DEMO_LIVE_ENABLED=1` 和专用桥接令牌。Key 文件及环境文件仅服务用户可读写，不能放进 `app/dist/web`、仓库或交付归档。桥接固定监听 `127.0.0.1:8791`；主服务的 `AGENT_BRIDGE_URL` 指向该地址，使用相同桥接令牌。

本次 Bridge 单元新增 `AGENT_DEMO_RUNNER_STATE_DIR=/home/tao/autoops-agent-demo/data/runner` 和 `AGENT_DEMO_MATERIALS_URL=http://127.0.0.1:8787`。前者保存原生线程绑定、用量基线和专用 `codex-home/`；后者是固定回环 origin，Bridge 按当前运行的授权向主服务读取本会话资料。CPA 仍使用独立临时 HOME 和工作目录，不使用个人登录状态，但专用 CODEX_HOME 现在持久保存。未配置状态目录时才退回临时 CODEX_HOME，此时 `sessions.durable=false`，不能承诺跨 Bridge 进程恢复。

初次 CPA 接入完成过 Secret 配置、启动和三轮合成资料真实验收；那份记录属于旧版。桥接初始化不访问模型，`configured/modelVerified:false` 不能视作推理通过。`test/agent-demo-grok-live.mjs` 提供真实模型验收，必须显式开启并从私有文件读取桥接令牌；它不登录 Demo，不替代完整 WebUI 验收。

主服务与 Bridge 均已启用开机启动，不依赖 Mac 或 SSH 隧道常驻。重启 Bridge 会丢失进程内事件重放和当前执行状态，但会话绑定及原生上下文从专用目录恢复；正在运行的主服务轮次仍会中断，需用户明确继续。确认过的线程不再每轮重发完整历史，重试会建立新的上下文 revision，删除会话也通过 Bridge 清理其绑定。真实验收与部署内容对应关系见 [验收记录](../examples/agent-demo-validation.md)。

## 更新和回退

更新前检查空闲轮次和磁盘空间，保留上一份后端、静态文件、服务单元、对应依赖及数据备份。使用已验证的构建产物上传，静态资源先于入口 HTML 替换。安装或修改服务单元后执行 `systemctl --user daemon-reload`，按 Bridge、主服务的顺序启动，检查健康接口、登录及实际交互。启动成功与真实模型验收分别记录。

回退时恢复相匹配的 `agent-demo`、`dist/web`、依赖/lockfile、服务单元和同批次数据。当前版本新增附件提取缓存，并将会话绑定与用量基线写入运行器状态目录；不能只回滚 SQLite 而保留更新后的原生上下文，也不能假设旧代码能够继续当前原生会话。需要保留更新后的数据供核对，再按备份批次恢复。

交付证据应记录构建文件哈希、服务器健康响应、运行环境、测试开始和结束时间。源码未提交时不能仅用 Git HEAD 标识实际部署代码。

## 数据备份与恢复

2026-10-21 磁盘维护：按用户要求保留现有数据及最近两份完整恢复点，移除已删除会话的63,963条旧事件（保留删除通知）和2,063条请求回执，然后执行SQLite压缩。现有9个会话、3个附件、草稿、偏好、有效会话与分支历史均核对摘要一致。数据库约1.4GiB降至14.2MiB；该操作没有修改应用代码，也没有引入自动回收策略。维护证据为 `.test-artifacts/agent-demo-storage-cleanup/report.json`。

本次维护后保留的恢复点是 `20261021T080522Z-before-storage-cleanup` 和 `20261021T072710Z-before-native-delete-fix`，每组包含 `.sqlite.gz` 与 `.tgz`。文中更早部署清单仍是历史记录，其中的旧备份文件已按本次两份保留要求轮转删除，不能再将旧路径当作可用恢复点。运行环境与当前 `app/node_modules`、`data/runner`、Secret均保留；只清理安装压缩包、发布暂存文件及包管理器缓存。

SQLite 使用 WAL。不要只在服务运行时复制主数据库文件而忽略 WAL。原生会话启用后，完整恢复点必须同时包含 SQLite 和 `data/runner`，并对应同一维护窗口：确认无活动任务，停止主服务与 Bridge，再通过 SQLite backup API 保存一致快照，并归档运行器状态目录。仅做在线 SQLite 快照，随后热拷贝 runner，不能保证两边对应同一轮次。

数据库备份可以 gzip 无损压缩，压缩后执行 `gzip -t` 校验。恢复前先校验并解压到暂存位置，再用 SQLite 完整性检查验证；解压应预留数据库原始体积的空间。代码 `.tgz` 与运行器 `-runner.tgz` 分别保留，备份文件权限为 600。

恢复时保持两个服务停止，保留当前数据目录，再恢复同批次 SQLite 与 runner；不要留下旧 WAL/SHM 与恢复的数据库混用。确认目录仅服务账号可写，再启动 Bridge 和主服务。检查会话、附件下载、队列暂停状态和原生会话恢复能力。备份包含私人会话正文、文件和运行器上下文，应按同等权限保存。

删除整个 data 目录会丢失全部演示内容，不属于日常更新步骤。演示测试脚本只清理自己创建的会话，不清理用户的体验记录。

## 验证命令

```sh
node test/agent-demo-api.mjs
node test/agent-demo-restart.mjs
node test/agent-demo-bridge-protocol.mjs
node --test test/agent-demo-attachments.test.mjs
node test/agent-demo-readiness.mjs
node test/agent-demo-native-sessions.mjs
node test/agent-demo-native-session-main.mjs
node test/agent-demo-transport-browser.mjs
AGENT_DEMO_ISOLATED=1 node test/agent-demo-adversarial.mjs
```

测试地址和证据目录的环境变量以各脚本头部及 helper 为准。API、可控 Bridge、原生协议替身及场景稳定性测试都不能作为真实模型通过的证据。`test/agent-demo-live-long-conversation.mjs` 需要显式设置 `AGENT_DEMO_LIVE_LONG=1`，默认 105 轮，先核对部署 buildHash，并验证同一原生线程和 `scope:'turn'` 用量；执行会使用当前真实模型配置。最终结果与未完成项记录在 `examples/agent-demo-validation.md`。
