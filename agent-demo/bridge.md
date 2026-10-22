# Codex App Server 运行器桥接

桥接负责真实 Codex app-server 的原生上下文、轮次、事件和受限业务工具。会话权限、项目成员、文件授权、业务消息与队列持久化、幂等业务请求由 `/api/agent-demo` 主服务负责；模型可见的工具结果和压缩上下文交给运行器保存。

2026-10-21 已核对本机 `codex-cli 0.159.2` 的 `--help`、实验协议生成结果，并通过无鉴权、无推理的真实 CLI 启动探针。依据 [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 与 [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。CPA `grok-4.6` 后续已完成本文末尾记录的三轮真实合成验收，未覆盖部分仍按验证边界记录。

本文的持久会话、按需文件读取、增量历史、时序诊断与原生删除描述本次本地修复后的契约。该修复已于 2026-10-21 部署。真实网页附件与滚动已通过；连续长测暴露 CPA/Grok 异常控制标记，不能据此宣称长会话稳定性达标。最新证据见 [验收记录](../examples/agent-demo-validation.md)，文末早先验收仅保留历史范围。

## 启动条件

Node.js 24 或更高版本。桥接本身不需要额外依赖；主服务的 PDF 提取依赖另由项目安装。运行：

```sh
node agent-demo/codex-bridge.mjs
```

启动前由部署过程注入配置；不把令牌放进命令行、仓库、前端或截图：

| 环境变量                      | 作用                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `AGENT_DEMO_BRIDGE_TOKEN`     | 必需，至少 32 字符的桥接专用随机令牌                                          |
| `AGENT_DEMO_BRIDGE_PORT`      | 默认 `8791`，只监听 `127.0.0.1`                                               |
| `AGENT_DEMO_LIVE_ENABLED`     | 仅显式设为 `1` 才初始化真实运行器；默认不可用                                 |
| `AGENT_DEMO_MODEL`            | 必须由用户确定可用模型；不猜测或自动替换                                      |
| `AGENT_DEMO_CODEX_BINARY`     | Codex CLI 可执行文件；默认使用本机桌面应用内置 CLI                            |
| `AGENT_DEMO_CODEX_HOME`       | 用户授权的运行器配置位置；由 CLI 自行读取，不由桥接读取或复制鉴权文件         |
| `AGENT_DEMO_PROVIDER`         | 默认 `codex`；显式设为 `cpa` 可使用独立 CPA Responses 提供方                  |
| `AGENT_DEMO_CPA_BASE_URL`     | CPA 必填 HTTPS API 基址，不允许 URL 内鉴权、查询参数或片段                    |
| `AGENT_DEMO_CPA_API_KEY_FILE` | CPA 必填专用密钥文件路径；内容不放在环境配置文件或命令行                      |
| `AGENT_DEMO_RUNNER_STATE_DIR` | 专用运行器状态目录；配置后保存会话绑定与 CPA 原生上下文，支持跨桥接进程恢复   |
| `AGENT_DEMO_MATERIALS_URL`    | 主服务固定回环 origin，例如 `http://127.0.0.1:8787`；只用于按需读取已授权文件 |

模型来源和授权未确认前，只启动禁用 live 的桥接验证 HTTP 协议。`/health` 会返回 `liveAvailable: false`。默认 `codex` 路径通过 `account/read` 检查是否已鉴权，不主动刷新 token，不保存或转发邮箱等账号元数据；账号是否有目标模型权限，仍由真实轮次验证。当前没有自动账号登录、凭据搬运和模型降级。

建议使用独立配置位置与账号运行，不使用个人开发工作区作模型工作目录。桥接为 app-server 创建空临时目录。不要把个人 `auth.json`、配置文件或环境密钥复制到测试机。

### CPA Responses 提供方

已确定的接入配置为 `AGENT_DEMO_PROVIDER=cpa`、`AGENT_DEMO_CPA_BASE_URL=https://x.996788.xyz/v1`、`AGENT_DEMO_MODEL=grok-4.6`。需要由部署流程另行提供已获授权的密钥文件；桥接不会查找其他工作区、服务器或个人账号中的密钥。

CPA 模式为每个桥接进程创建独立空白 `HOME` 和工作目录，忽略默认路径的 `AGENT_DEMO_CODEX_HOME`。配置 `AGENT_DEMO_RUNNER_STATE_DIR` 后，专用 `CODEX_HOME` 位于该目录下的 `codex-home/`，原生上下文保留供重启恢复；没有配置时仍使用临时 `CODEX_HOME`，健康能力中的 `sessions.durable` 为 false，不能承诺跨进程恢复。专用状态目录不是个人 Codex 配置目录。

子进程只接收运行所需白名单环境和 `CPA_API_KEY`，密钥从专用文件读取，不进入 argv、TOML 配置或 HTTP 健康检查。文件须为当前进程用户拥有、组和其他用户均无权限的普通文件，拒绝末级符号链接及超过 16 KiB 的内容；推荐权限 `0600`。初始化失败和正常关闭时删除桥接创建的临时 HOME、工作目录和临时状态，不删除显式配置的持久状态目录。状态目录及原生上下文目录使用 `0700`，绑定索引使用 `0600`。

提供方固定使用 `wire_api=responses`、`requires_openai_auth=false`，不调用 `account/read`，不依赖 OpenAI 登录。`thread/start` 明确指定 CPA 和目标模型、禁止自动回退，并核对返回的提供方、模型及原有权限配置。引导仍使用同轮 `turn/steer`，停止仍使用 `turn/interrupt`，澄清仍通过现有业务 dynamicTools，不另建 HTTP Agent 循环。

`/health` 中 `liveAvailable:true` 表示配置和初始化已成功，可接受轮次；`readiness:configured`、`modelVerified:false` 及提示表示尚未验证模型。只有本桥接观察到轮次 `completed` 后才返回 `readiness:verified`、`modelVerified:true`。这只证明出现过完成轮次，不是后续可用性或全部工具边界的保证。仅通过启动探针不能宣称真实模型、流式响应或工具调用已验证。

## 连接边界

当前 CPA 部署中，主服务与桥接均运行在 `192.168.31.157`，通过该机器回环地址连接；不依赖 Mac 或 SSH 隧道常驻。下面的反向转发方式仅适用于使用本机运行器的可选部署。

主服务与桥接可在同一台已授权服务器运行，通过 `127.0.0.1` 连接；若桥接在另一台主机，使用已有授权 SSH 连接的端口转发，远端绑定也限定 `127.0.0.1`。不开放公网端口，不开启 SSH `GatewayPorts`。具体服务器、用户和 SSH 密钥使用部署阶段已确认的连接，不在这里假设。

每个请求都必须携带 `Authorization: Bearer <桥接令牌>`，包括健康检查和 SSE。桥接拒绝 `Origin` 请求头与非本机 `Host`；浏览器不能直连，由主服务在授权后代调。令牌只存在于两端服务进程的安全配置中。

主服务端使用 `AGENT_BRIDGE_URL` 和 `AGENT_BRIDGE_TOKEN`。其中主服务的 `AGENT_BRIDGE_TOKEN` 与桥接进程的 `AGENT_DEMO_BRIDGE_TOKEN` 必须相同；URL 指向回环地址上的桥接或 SSH 转发端口。

## HTTP 契约

请求和响应为 JSON；错误 `{code,error}`。请求上限 20 MiB。`runId` 只能使用字母、数字、下划线、短横线、点和冒号，最长 160 字符。

| 方法   | 路径                       | 输入及结果                                                                                          |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/health`                  | `{liveAvailable,name,provider,readiness,modelVerified,capabilities,version,model,reason?}`          |
| POST   | `/runs`                    | 下述轮次数据；首次 `202 {runId,status:"starting"}`；同 ID 同输入返回现状，不重复开轮                |
| GET    | `/runs/:id/events?after=N` | SSE；也接受 `Last-Event-ID`；从 N 后继续，默认从头回放                                              |
| POST   | `/runs/:id/steer`          | `{requestId,text,expectedRunnerTurnId}` → `{accepted:true,runnerTurnId}`                            |
| POST   | `/runs/:id/stop`           | `{requestId,expectedRunnerTurnId?}` → `{accepted:true,runId,status}`；尚未开始的轮次可不传运行器 ID |
| POST   | `/runs/:id/answer`         | `{requestId,questionId,answer}` → `{accepted:true,questionId}`                                      |
| DELETE | `/sessions/:id`            | 删除该业务会话绑定的当前与被替换的原生 thread，再清除绑定及事件缓存；有活动轮次时返回 409           |

轮次输入：

```json
{
  "runId": "由主服务生成的轮次ID",
  "session": { "id": "由主服务生成的会话ID", "revision": 0 },
  "prompt": "分析当前环境并生成 Markdown 报告",
  "context": {
    "projectId": "project_1",
    "projectName": "项目",
    "environmentId": "environment_1",
    "environmentName": "测试环境",
    "observedAt": "2026-10-21T00:00:00.000Z",
    "documents": [{ "id": "doc_1", "name": "项目说明", "content": "已授权正文" }],
    "resources": []
  },
  "history": [
    { "role": "user", "content": "先前输入" },
    { "role": "assistant", "content": "先前回答" }
  ],
  "attachments": [
    {
      "id": "file_1",
      "name": "说明.txt",
      "mime": "text/plain",
      "reference": true,
      "readable": true
    }
  ],
  "sessionAttachments": [
    {
      "id": "file_older",
      "name": "先前资料.pdf",
      "mime": "application/pdf",
      "reference": true,
      "readable": true
    }
  ]
}
```

主服务必须只传当前用户可读、属于当前项目、环境和会话的内容。模型与 `/runs` 输入不能指定文件路径、远程 URL 或回调地址。文件读取只使用部署配置中的固定主服务回环 origin，不接受重定向。

兼容主服务的嵌套上下文：`project:{id,name}`、`environment:{id,name}`。`resourceSnapshot` 会作为演示夹具返回，明确不是生产实时数据。继续请求可带 `partialOutput` 和 `originalGuidance`，将作为先前执行上下文交给新轮次。

`attachments` 是当前轮最多八个附件；`sessionAttachments` 是主服务确认本轮可读取的会话历史附件目录。当前文本与 PDF 使用 `reference:true`，模型实际调用 `read_attachment` 时，桥接用同一专用令牌向主服务发出 `POST /internal/runs/:runId/attachments/:fileId/read`。主服务再次检查活动轮次、会话权限与文件归属，返回 `{file:{id,name,mime,readable,extraction,content?,sourceUrl}}`。桥接核对 ID、限制响应大小，并在本轮内缓存读取结果；测试可注入 `readAttachment(runId,id)`，不用真实网络与文件。稳定文件 ID 对应不可变内容，若将来允许替换内容必须提供内容版本或 `contentDigest`。

当前图片可传 `data`（纯 base64），支持 PNG、JPEG、WebP、GIF，最多 8 MiB/文件；只把当前图片作为本轮视觉输入，历史图片目录明确提示需重新附加才能重新视觉分析。该呈现变化不等于撤销原有文件授权。旧文件没有提取状态时允许第一次按需读取；明确不可读的文件保留 `extraction` 原因，工具告知用户而不假装读到正文。文本型 PDF 的抽取由主服务负责，扫描件、损坏文件、加密或不支持格式不能仅凭上传成功认定可读。预览/下载原文件仍是独立能力。兼容注入工具测试直接传 `content`，正式文件流程使用稳定引用。

### 原生会话与上下文边界

这一层采用 [OpenChamber `sendMessage`/`compactSession`](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/opencode/client.ts) 的分工：保留运行器会话，逐轮发送新增输入，由运行器维护历史和压缩。AutoOps 使用 Codex 原生 `thread/start`、`thread/resume`、`turn/start`，没有复制 OpenCode 引擎，也不自行生成摘要或静默截掉旧消息。

| 条件                                  | 行为                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| 首次有 `session.id`                   | 建立 `ephemeral:false` 的原生 thread；仅首次导入主服务保留的 `history`         |
| 普通追问、排队出队、继续              | 保持相同会话 ID 和 revision，在已加载的原生 thread 中创建新 turn               |
| 桥接重启或原生 thread 已卸载          | 按持久绑定调用 `thread/resume`，使用 `excludeTurns:true`，避免重新拉取整份历史 |
| 重试或重新生成                        | 主服务递增 `session.revision`，新建原生上下文；导入的历史不含被重试回答        |
| 分支                                  | 新业务会话 ID、新原生上下文；主服务复制并重映射文件引用，不继承源会话绑定      |
| 资料或资源授权撤销、固定项目/环境改变 | 隔离旧原生上下文，且不重放可能包含撤销内容的旧 transcript                      |
| 新增附件、快照时间/观测值变化         | 继续原生上下文；工具仍读取当前轮新的授权目录和快照                             |
| 没有 `session`                        | 保留兼容的临时 thread 模式，仅用于旧适配器或独立协议测试                       |

`runtime-sessions.mjs` 仅保存业务会话 ID、revision、原生 thread ID、授权指纹、用量基线以及被替换的 thread ID；不再保存一份 transcript 或自制摘要。授权指纹区分项目、固定环境、文档内容版本、资源授权身份与不可变附件身份，不把 CPU 观测值和采集时间误认为权限变化。

主服务在原生 thread 已确认且 revision 未改变后发送 `history:[]`，并在 `session.expectedThreadId` 中固定期望原生身份。绑定缺失或不匹配返回 `SESSION_CONTEXT_MISSING`，不会静默创建空上下文；首轮启动尚未确认且进程已经重启时返回 `SESSION_CONTEXT_UNCERTAIN`。首次迁移、分支和显式重试才传所需完整历史。历史不再限制为 200 条，但 HTTP 的 20 MiB 传输保护和模型上下文容量仍存在，超大旧会话迁移不能靠无限增大请求解决。

真实 CLI 无推理探针证实：首个 turn 之前的 durable thread 还没有可恢复的 rollout。绑定因此记录 `initialized`，它表示已收到 `turn/start` 确认，不是独立磁盘持久性证明；重启后未初始化且无已确认期望身份的线程按初始导入处理，已有期望身份则明确失败。已执行线程的实际恢复仍需故障测试。原生 thread 的恢复不等于恢复上一轮进程执行位置；“继续”仍创建新 run/turn，保留可见部分结果。`steer` 则严格调用当前 turn 的 `turn/steer`，不会取消重启。

会话删除使用官方 `thread/delete`，同时覆盖重试和撤权留下的旧原生上下文；不猜测 Codex 磁盘路径。删除完成后清除本地绑定与对应事件缓存，原生删除失败时保留绑定供重试。主服务须对已经分发原生运行、包括尚无 `started` 回执的 pending 会话执行此清理，并阻止删除期间的新轮次。停止、归档和删除是不同操作；归档不删除模型上下文。

删除进度通过绑定内的 `deletionPending` 持久化：每个原生 ID 删除成功后立即保存剩余清单，失败重试与重启恢复跳过已经确认的 ID；整个删除未完成时不允许该会话启动新轮次。若进程在原生删除成功、进度落盘之前退出，仅对注册表内 ID 的 `thread/delete`、错误码 `-32600` 和精确的 `thread not found: <id>` / `no rollout found for thread id <id>` 视作已删除，其余错误仍然失败。分类后不保留或透传原始 RPC 错误。真实 CLI 无推理重复删除探针验证了后一种文案，见 `.test-artifacts/agent-demo-api/codex-delete-idempotency.json`；不能把所有运行器错误当成删除成功。

## SSE 事件

所有事件使用 `event: message`、递增 `id` 和以下 JSON：

```json
{ "seq": 1, "type": "started", "runId": "run_1", "payload": {}, "at": "ISO时间" }
```

| type                 | payload                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `started`            | `{runnerThreadId,runnerTurnId,sessionMode,nativeContext}`，只发一次                             |
| `delta`              | `{text,itemId,messagePhase?}`，可见正文与上游公开消息阶段                                       |
| `reasoning`          | `{id,itemId,text,mode,kind,status}`，仅提供方实际公开返回的摘要/过程文本，与正文分开            |
| `usage`              | 每轮用量差额，`scope:"turn"`；另带 `threadTotal`、`last`、`modelContextWindow`，未知计数为 null |
| `timing`             | `{phase,elapsedMs,at}`，从桥接接受本轮起计算的真实协议里程碑                                    |
| `context.compaction` | `{status,source:"codex-native"}`，status 为 running 或 completed，原生压缩生命周期              |
| `tool`               | `{id,name,status,input,output?}`，status 为 running、completed 或 failed                        |
| `question`           | `{id,prompt,options:string[]}`，回答接口使用这个 ID                                             |
| `artifact`           | `{id,name,mime,content}`，主服务保存文件后生成自己的授权 URL                                    |
| `completed`          | `{runnerThreadId,runnerTurnId,timings}`                                                         |
| `failed`             | `{runnerThreadId,runnerTurnId,code,error,timings}`                                              |
| `interrupted`        | `{runnerThreadId,runnerTurnId,code?,timings}`                                                   |

SSE 断开不停止运行。事件保存在桥接内存，每轮最多 32 MiB，同时最多五个活动轮次，同一原生会话只能有一个活动轮次。终态缓存最多保留一小时、至多 200 轮；缓存满时淘汰最旧且没有订阅的终态，不把缓存条数当成会话长度限制。单轮事件超限或全部缓存仍在使用时明确失败/拒绝，不截断活动轮次。主服务持久化终态快照，并按 `(runId,seq)` 处理事件。

桥接重启后内存 run、控制幂等缓存和 SSE 序号不会恢复；主服务应把失联轮次标记失败/中断并暂停队列。持久原生 thread 可用于用户后续新轮次的上下文恢复，不代表旧 SSE 自动续传或旧任务自动续跑。浏览器到主服务的缺口补流是另一层机制。

时序里程碑为 `threadReady`、`turnStarted`、`firstRunnerEvent`、`firstReasoning`、`firstText`、`firstTool`、`finished`，只在实际收到对应协议事件或完成相应操作时记录。`firstRunnerEvent` 可只是 `turn/started`，不是模型首 token；`firstText` 是桥接收到可见正文，不是浏览器首次绘制。主服务另记录准备阶段，前端验证另测绘制，不能互换这些延迟指标。原生 thread 的累计用量减去本轮开始基线后作为每轮用量，避免复用 thread 后把旧轮计费重复累加。

停止接口确认的是中断请求已被运行器接受，最后以 `interrupted` 终态确认结束。桥接从收到停止请求开始不再发布正文、工具、问题和文件事件；主服务同时暂停业务队列。主服务负责持久化用户 `requestId` 的幂等，桥接也按 `(runId,action,requestId)` 合并并发和缓存结果，包括运行器确认超时；同 ID 不同输入返回 409，避免 HTTP 重试重复 steer 或重复答题。超时的同 ID 不会再次送入运行器，需要主服务结合事件查明状态。

## 只读业务工具

- `list_project_materials`、`read_project_document` 读取已授权目录与传入文档；`read_attachment` 只读目录内 ID，通过固定主服务接口按需取得正文。
- `query_environment` 只返回固定环境快照、来源和观测时间，不执行 SSH、数据库查询或任意 URL 请求。
- `ask_user` 保持动态工具请求悬挂，接到当前问题答案后才返回模型。
- `create_report` 只生成 Markdown、纯文本、CSV 或 JSON 内容事件，不写本机文件；主服务负责文件持久化。

桥接对 shell、apps、plugins、memories、多 Agent、web search、skills 自动指令和 MCP 做显式禁用；使用 `agent_demo` 命名权限配置拒绝模型工具访问根目录及网络。意外出现命令、文件变更、MCP、搜索、图片路径读取或子 Agent 工具事件会中断运行并使 live 不可用。未知服务器请求一律拒绝。运行器原始 stderr 和错误正文不透传，以免将本机配置或鉴权信息带到测试机。

创建 thread 后还会校验返回的权限 profile 必须是 `agent_demo`、审批策略为 `never`、沙箱为 `readOnly` 且网络关闭；不符合就关闭运行器，不能开始模型轮次。这些配置与中断检测是实现措施，不能替代真实边界验证；事件到来后的中断也不是事前隔离。启用 live 前需要确认当前 CLI 接受全部配置、动态工具可用、文件与网络权限实际生效。若配置不被支持，初始化失败，不能删掉保护参数绕过。

## 验证状态

已通过 Node 24 语法检查与不调用模型的注入协议检查：本机鉴权、Origin 拒绝、运行创建去重、同 ID 并发引导/回答/停止合并、跨资料 ID 拒绝、二进制未读提示、澄清解除、报告事件、停止后不再输出正文、SSE 顺序和游标回放。检查没有启动 Codex 子进程。这些注入检查本身不证明真实模型能力；后续 CPA 实际验证见本节末尾。工具隔离边界、真实五会话并发和完整网页流程仍未完成验收。不得用注入测试通过代替真实模型通过。

在仓库根目录运行 `node test/agent-demo-codex-bridge.mjs` 可重跑 30 项协议断言（含授权资料/附件的站内引用 URL）。脚本只绑定随机回环端口，运行器由测试注入；不读取凭据、不启动 Codex、不请求模型。结果写入 `.test-artifacts/agent-demo-api/codex-bridge.json`，包含测试时间、Node 版本和实现/测试文件 SHA256。

另有真实 CLI 启动检查：在 Codex 现有 macOS 工具沙箱中运行 `node test/agent-demo-codex-startup.mjs`。脚本要求 `CODEX_SANDBOX=seatbelt` 且网络限制标记开启；不得为运行此脚本解除网络限制或手工伪造这些标记。它为子进程单独创建空白 `HOME`、`CODEX_HOME` 和工作目录，从零构造环境，不继承 API key。探针使用临时、无鉴权且只指向不可达回环端口的提供方，全部业务隔离参数保持原值；这不是实际模型配置。

基础启动探针使用 `initialize`、`initialized`、`permissionProfile/list`、`config/read` 和 `thread/start`；持久线程模式额外允许 `thread/resume`、`thread/delete`。已确认实际 CLI 接受 `--stdio --strict-config`、现有工具禁用参数及六个 `dynamicTools`，返回 `agent_demo / never / readOnly / networkAccess:false`，没有轮次、指令来源文件或工作区根目录。未调用 `account/read`、`turn/start` 或业务工具，未接入真实模型。基础结果保存在 `.test-artifacts/agent-demo-api/codex-startup.json`，临时目录结束后删除。该证据只能证明初始化、配置解析及动态工具注册兼容，不能证明实际模型调用能力或文件、网络隔离的运行时行为。

CPA 新增验收独立保存在以下路径，原有验收文件不被替换：

- `node test/agent-demo-codex-provider.mjs`：22 项集中断言，仅自建假 CLI 与临时随机测试数据。检查 CPA 配置、空目录、子进程环境、密钥文件权限、无账号读取，以及 RPC 错误、`turn/completed.error` 和 `error` 通知不泄漏原始提供方正文。报告 `.test-artifacts/agent-demo-api/codex-cpa-provider.json`。
- `AGENT_DEMO_PROTOCOL_REPORT=.test-artifacts/agent-demo-api/codex-cpa-protocol.json node test/agent-demo-codex-bridge.mjs`：现有 30 项协议回归针对新源码重新运行，仍为注入测试。
- `AGENT_DEMO_STARTUP_PROVIDER=cpa node test/agent-demo-codex-startup.mjs`：在现有禁网沙箱中验证实际 CLI 接受 CPA 配置、模型标识及动态工具注册。使用不可达 HTTPS 回环端口，没有密钥，也没有推理调用。报告 `.test-artifacts/agent-demo-api/codex-cpa-startup.json`。不能改为真实 CPA 地址或解除网络限制来绕过探针约束。

上述测试均不证明 CPA 的真实密钥、模型权限或模型流式行为可用。真实模型接入需在相应授权到位后另行验证，不以启动和注入结果替代。

### 本次上下文修复的本地证据

- `node test/agent-demo-native-sessions.mjs`：14 项协议检查、225 个注入运行器 turn；其中连续 205 轮保持同一原生 thread，240 条旧历史只首次导入。另验证绑定重启恢复、每轮用量、原生压缩事件转发、附件按需读取、重试/分支/继续、撤权隔离、快照与图片呈现变化、期望身份校验及完整原生删除。报告为 `.test-artifacts/agent-demo-api/native-sessions.json`。没有启动真实 Codex 或调用模型。
- `AGENT_DEMO_STARTUP_PROVIDER=cpa AGENT_DEMO_STARTUP_DURABLE=1 node test/agent-demo-codex-startup.mjs`：受现有禁网沙箱约束的真实 CLI 无推理探针，确认持久 thread 可创建、首个 turn 前 `resume` 明确返回没有 rollout、官方删除可清理本探针空线程。报告为 `.test-artifacts/agent-demo-api/codex-cpa-startup-durable.json`。这项检查没有证明已执行线程跨进程恢复，更没有执行真实长上下文压缩。
- `node test/agent-demo-codex-reasoning.mjs`：10 项事件回归，包含正文/公开过程分离、上游阶段、每轮用量及旧轮累计值的区分。报告为 `.test-artifacts/agent-demo-api/codex-reasoning.json`。

本次修复还需在部署后的原配置上验证多轮 thread 身份、历史附件与 PDF 工具读取、重启后新轮恢复、长文正文等待和真正触发上下文容量后的原生压缩。诊断点已建立不等于 101 秒正文等待已经消除；旧版本的真实验收也不能替代这些检查。

## 早先部署的 CPA 真实验证（2026-10-21，本次上下文修复前）

用户明确授权读取 CPA Secret 后，测试机以 `grok-4.6`、Codex CLI 0.159.2 完成三轮合成验收：资料、文本附件、环境快照的实际工具读取，报告与站内引用；澄清等待期间的同轮 `turn/steer` 和回答标记；流式停止回执与无后续正文。模型、提供方和 runnerTurnId 均有事件证据，未自动回退模型。报告见 [真实 Grok 记录](../.test-artifacts/agent-demo-grok-live/grok-live-2026-10-20T23-52-31-907Z-2845ad6b/report.json)，部署哈希见 [对应校验](../.test-artifacts/agent-demo-grok-live/grok-live-2026-10-20T23-52-31-907Z-2845ad6b/deployment-attestation.json)。

这是桥接接口的真实模型验收，不是 WebUI 全流程验收。停止证据是运行器中断请求得到确认、桥接发布 interrupted 且随后不再发布正文；桥接会把停止中的 completed 归一为 interrupted，因此不能据此独立证明 CPA 上游内部执行或计费在同一时刻终止。工具只使用合成的内存数据，没有连接真实业务数据库或执行服务器命令。
