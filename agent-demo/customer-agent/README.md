# AutoOps 客户连接程序

客户目录仍留在本机。连接程序主动通过 HTTPS/WSS 连接中心，用本机已安装并登录的 Codex 执行中心绑定到该目录的对话。平台 CPA、平台资料、平台技能和密钥不会复制到这里。

程序复用仓库锁定的 T3 Codex 执行模块与 Provider 事件合同；设备接入与可靠投递实现依据 [已批准架构方案](../../examples/agent-demo-customer-agent-architecture-plan.md)。这不是任意原生 RPC 或远程桌面代理。

## 构建与运行

开发环境先安装仓库及 `vendor/t3code` 的锁定依赖，然后运行：

```sh
node scripts/bundle-customer-agent.mjs
```

将 `dist/customer-agent/` 分发到客户电脑，保留目录中的许可文件。客户需要 Node.js 24.10 或更新版本，以及已安装、已登录的 Codex CLI。程序不替客户登录模型服务。

构建同时生成 `dist/customer-agent.zip`、对应 `.sha256` 及包内逐文件清单。不能只复制入口 `.mjs`：相邻分块和许可文件也属于完整安装包。中心网页“更多功能 → 我的电脑”（窄屏为“切换模块 → 我的电脑”）提供配对与安装包下载。设备管理属于当前账号，不随顶部项目切换而改变归属；新对话只列出该项目已经登记且可用的目录。

构建使用 T3 现有的第三方许可收集器，按全部分块的实际依赖生成 `THIRD-PARTY-NOTICES.txt` 和机器可读的许可清单；缺少依赖许可或混入平台业务模块时构建失败。

```sh
node autoops-customer-agent.mjs --help
node autoops-customer-agent.mjs connect --url https://中心地址
```

在中心网页生成一次性配对码，在本机命令提示中输入。配对码过期或已用时，重新从网页生成。设备长期凭据只保存到本机，不会打印。避免把配对码放进脚本或命令历史；`--code` 仅用于受控自动化场景。

登记本机目录时指定中心项目 ID：

```sh
node autoops-customer-agent.mjs register --project 项目ID --path /本机/项目目录 --label 我的开发目录
node autoops-customer-agent.mjs status
node autoops-customer-agent.mjs run
```

Windows 的目录路径可写为 `--path "D:\Projects\Demo"`。登记的是当前目录及其身份；中心只收到登记 ID、名称和项目归属。目录移动或同路径替换后，旧绑定不能自动指向新目录。

默认权限为 `workspace-write`、`on-request`，沙盒网络关闭。需要不同本机策略时，在登记时明确选择：

```sh
node autoops-customer-agent.mjs register --project 项目ID --path /项目 --label 只读检查 --read-only
node autoops-customer-agent.mjs register --project 项目ID --path /另一个项目 --label 联网开发 --network-access --approval-policy untrusted
```

中心不能传入任意本机 cwd、替换目录或提高本机权限。实际沙盒支持范围仍取决于客户 Codex 和操作系统；程序没有“自动回退完全访问”。首版没有中心安装技能或修改本机权限的入口。

默认状态目录为 `~/.autoops/customer-agent/`；所有命令可指定 `--state-dir` 使用另一独立目录。设备凭据 `device.json` 与 SQLite 日志分开保存，POSIX 系统目录权限为 `0700`、凭据与数据库为 `0600`。Windows 使用当前用户的目录访问控制；本机管理员仍能访问其管理的文件，不应将状态目录放到共享位置。

## 断线、停止与恢复

- 关闭网页不停止客户执行；WebSocket 断线也不关闭本机 Codex。
- 连接使用心跳和带抖动的退避重连。已有 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境配置通过现有 Undici 代理实现生效。公网必须 HTTPS；`--allow-insecure` 只供明确选择的测试网络使用。
- 同一命令 ID 先记录再执行，重复投递返回原回执；原生操作结果不明时保持未知，不自动再发输入。
- 正文、工具结果、审批和终态先落盘，中心确认持久处理后再清理。实时命令增量单独传输，拥塞时可丢弃中间片段，最终工具结果仍走可靠通道。
- 日志高水位阻止新轮次；接近上限时请求停止活动执行。单条结果上限约 `900 KiB`，超限明确报错并保持待核实，不能静默声称完整结果。恢复日志默认预算 `64 MiB`，保留控制与终态空间。
- 同一个规范化目录串行执行；重复、符号链接别名和父子重叠目录不能重复登记。未知执行不因离线或超时释放占用。
- 每个连接程序最多保留 `32` 个受管会话。首版不做静默空闲回收；达到上限后先停止活动任务，再重启连接程序。历史留在中心，续接使用原生 thread，不重放用户输入。

运行中按一次 `Ctrl+C`，有活动或未知任务时会提示先停止任务。确认要强制退出时，在五秒内再按一次；这会关闭本连接程序管理的运行器并保留未知状态和工作区占用，**不代表所有工具已确认结束**。

本机撤销目录：

```sh
node autoops-customer-agent.mjs revoke --workspace 登记ID
```

这立即拒绝新的本机操作，并由运行中的连接程序请求停止当前轮次；网页实际停止状态仍等待真实终态。中心暂不可达时本机撤销仍然已经保存。

如果异常退出留下“结果待核实”，先检查原生 Codex 及其工具进程，确认旧受管进程已结束。停止连接程序后，再明确确认：

```sh
node autoops-customer-agent.mjs status
node autoops-customer-agent.mjs resolve --session 会话ID --confirm-stopped
node autoops-customer-agent.mjs run
```

`resolve` 保留人工核实记录，并向中心报告旧 run/attempt。旧轮次以“结果不完整”结束，不自动重做、回滚或伪造成成功。该操作要求连接程序当前未运行；不应只因为网页离线就使用它。

## 发送图片与文件

连接程序 0.2.0 起，在绑定这台电脑的问答中选择文件、拖拽或粘贴截图后发送即可。连接程序自动接收附件，图片交给 Codex 的图片输入，其他文件由 Agent 在本机读取。附件保存在连接程序的私有缓存，不自动放进项目目录或共享工作区。

更新时先结束本机活动任务，再退出旧连接程序，用新安装包和原 `--state-dir` 启动；保留设备配对与目录登记。旧程序仍可发送文字，上传入口在新能力同步后出现。


## 引用电脑项目文件

连接程序 0.3.0 起，点击输入框的附件按钮选择“引用电脑文件”，或输入 `@` 搜索已登记项目目录。展开目录按需读取，点开文件只预览前 16 KiB；选择后直接发送，由这台电脑的 Agent 读取当前原文件，无需上传源码。手机访问时也能使用。

只能选择当前对话绑定的电脑目录。目录被撤销、移动或文件已删除时会明确失败；链接文件不开放。历史标签指向原登记路径，预览显示当前内容，不代表历史文件快照。二进制文件只显示元数据，仍可引用给本机 Agent。

## 首版能力与验证边界

已接入：固定登记目录、本机 Codex、文本、图片和文件附件与实际工具事件、引导、停止、审批、模型及强度、真实本机技能发现与执行、命令去重、事件补传及手动异常恢复。

未开放：本机产物回传、平台资料与报告工具、共享控制、子 Agent、计划、Git 管理和任意已运行 Codex 会话接管。技能只回传身份、名称和描述；执行前复核目录及技能身份，不上传技能正文和依赖。

验证命令：

```sh
node --test agent-demo/customer-agent/customer-agent.test.ts
node --test agent-demo/customer-agent/transport-integration.test.ts
node --test agent-demo/customer-agent/distribution.test.ts
```

第二项需要允许本机监听 `127.0.0.1` 和启动测试专用子进程。它通过真实 WebSocket、真实 T3 事件转换和一个可控 Codex 协议 fixture 子进程验证丢回执、重连与副作用去重；**不能替代真实模型和普通公网验收**。Windows、系统沙盒支持、代理网络及真实模型版本的实际验证结果应随发布另行记录，不能由本机 fixture 通过推导为已支持。

真实模型的隔离验收脚本为 `agent-demo/customer-agent/live-validation.mjs`。它要求显式提供本地隔离中心的 `CUSTOMER_LIVE_ORIGIN` 与私有凭据文件 `CUSTOMER_LIVE_KEY_FILE`，通过发布产物实际执行配对、目录登记和连接；另建临时工作区与 Codex 配置，不改个人设置。`CUSTOMER_LIVE_PHASE=baseline` 验证文件读写与多轮本机技能，`full` 追加排队、停止与原生审批。`steer` 验证同轮引导，停止空闲连接程序并重新连接后用 `resume` 验证同一原生 thread 的新进程续接；两者通过 `CUSTOMER_LIVE_THREAD_ID` 指定同一测试会话。仅在明确提供已经发现的能力快照 `CUSTOMER_LIVE_CAPABILITIES_FILE` 时，测试才可选择其真实支持的 `CUSTOMER_LIVE_REASONING_EFFORT`。结果写入 `.test-artifacts/customer-real/client/`，回环网络结果不能代表公网延迟已经验收。

## 中心启用与升级

先构建现有 T3 worker、网页与客户 ZIP，保留现有网关、数据目录和平台模型配置，在 worker 与网关使用同一环境：

```sh
AUTOOPS_CUSTOMER_AGENTS=1
AUTOOPS_CUSTOMER_AGENT_BUNDLE=/发布目录/dist/customer-agent.zip
```

没有配置客户安装包或文件缺失时，下载接口返回明确的不可用错误，不返回假的安装包。公网入口必须配置可信 HTTPS，转发现有 `/api/agent-demo/t3/` 路径和 WebSocket Upgrade；反向代理不能缓存设备接口或缓冲持续连接。网页和连接程序均使用该入口，客户无需开放入站端口。

中心发布包默认不包含客户 ZIP，也不会因为本地已有 ZIP 就自动开放客户模块。需要分发时，构建并校验客户包后显式纳入：

```sh
node scripts/package-t3-release.mjs /新的发布目录 --customer-agent-bundle dist/customer-agent.zip
```

打包和发布校验同时检查压缩包、逐文件清单与许可文件。仍需在实际运行环境显式设置上述两个变量；分支合并与安装包入库本身不代表已开启公网接入。

更新顺序为中心兼容新合同 → 发布客户包 → 开放入口。更新前先检查活动轮次；不要在客户仍运行时直接恢复不认识远程执行的旧 worker。停止新接入不等于确认当前任务已停止，恢复通道和历史应保留到任务完成或人工核实。数据库备份应包含原 T3 数据及新增的设备登记、投递日志，不能只恢复其中一份再自动重做未知任务。

本轮实际部署/验收范围与未覆盖项见 [架构方案实施记录](../../examples/agent-demo-customer-agent-architecture-plan.md#首版实施记录)。普通公网和 Windows 验收完成前，定位为开发验证版。
