# AutoOps 与 T3 对话模块接口

当前实现固定使用 T3 Code v0.1.1，提交 `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`。交互范围和差异以[迁移方案](agent-demo-t3-migration-plan.md)为准；[覆盖表](agent-demo-t3-module-coverage.md)记录验证程度。本文件描述新运行链路，旧 SSE/Conversation JSON 协议仅用于识别迁移前数据。

当前开放范围以 [精简版能力边界](agent-demo-lite-profile.md) 为准。下文保留完整模块的协议说明；精简版的新计划、分支、回退、自动整理和交互式产物调用会在执行前被拒绝，旧历史读取不受影响。

## 单一对话链路

浏览器使用迁入的 AppRoot、ChatView、Tiptap、LegendList、Atom 状态和原生客户端连接。`web/src/agent-demo/t3/T3Host.tsx` 只提供登录、用户存储命名空间和业务宿主入口。发送、引导、队列、请求、分支、回退、历史和工具详情不经旧 Demo 状态机。

网关 `agent-demo/server.mjs` 的 `AGENT_DEMO_ENGINE=t3` 模式将 `/api/agent-demo/t3` 同源转发至仅监听回环的 T3 core。它不重写命令或合成模型事件。旧会话读写、消息发送及 SSE 入口返回 410；已有旧文件 URL 经授权与 ID 映射跳转到新端点。登录保留原 HttpOnly 会话 Cookie，登出后重载并切换用户存储命名空间。

原生协议的唯一类型来源是 `vendor/t3code/packages/contracts/src/orchestrationV2.ts` 及同目录 RPC/附件/设置合同。浏览器通过迁入的客户端使用协议版本 2，不自行实现另一套 WebSocket 编码。

## 业务边界接口

下列路径均在 `/api/agent-demo/t3` 下。变更请求要求当前登录及 `X-Demo-CSRF`；业务权限始终由服务端重新检查。

| 接口 | 用途 |
| --- | --- |
| `GET /autoops/bootstrap` | 当前用户、允许的项目/环境/Agent、固定模型、`productProfile`、顶层 `capabilities` 与 `clientSettingsOverrides`；不返回 CPA Key |
| `POST /autoops/thread-bindings` | 在原生 launch 前绑定新 threadId 的项目、固定环境、Agent 和可见范围；不能认领已有未迁移线程 |
| `GET /autoops/thread-bindings/:threadId` | 当前用户获授权的范围、只读迁移原因和父子来源 |
| `GET /autoops/legacy-drafts` | 当前用户的旧草稿，交由原生 Stash 恢复并去重 |
| `GET /autoops/resources?path=…` | 授权资源身份对应的文件内容；`metadata=1` 返回预览元信息；目录浏览采用原生资源 RPC |
| `GET /autoops/projects/:projectId/documents/:documentId` | 真实项目资料内容或元信息 |
| `GET /autoops/attachments/:id` | 当前可见历史范围内的附件 |
| `GET /autoops/files/:id` | 实际保存的业务报告或计划资料 |
| `POST /autoops/plan-materials` | 保存当前真实 proposed_plan；核对原生计划正文和 run，禁止以此写任意文件 |

上传、签名预览、HTML、MCP App、原生历史分页等继续采用 T3 自己的端点，在 HTTP/RPC 入口统一附加业务授权。元信息可见并不意味着文件字节可见；签名资源请求仍绑定有效用户会话。

`productProfile` 当前为 `{ id: "project-assistant-lite-v1" }`；兼容完整配置为 `t3-demo-full-v1`。`capabilities` 和 `clientSettingsOverrides` 位于 bootstrap 顶层。界面只消费服务端声明，服务端仍独立检查每次操作，不能把隐藏入口当作执行限制。有效偏好覆盖通过读取层合并，保存仍基于原始用户偏好；切换配置不覆写隐藏偏好或历史。

产品策略内部拒绝码为 `AUTOOPS_PRODUCT_CAPABILITY_DISABLED`。RPC 沿用原生错误通道，仅此已知拒绝保留固定中文提示“精简版暂不开放此操作，已有对话和资料仍可查看”；其余鉴权异常不透传内部原因。

## 命令、回执与读取

| 行为 | 原生入口及约束 |
| --- | --- |
| 创建并发送 | `orchestration.launchThread`；宿主先建立业务范围，initialMessage 作为同一个原生 launch 的输入 |
| 发送/排队/引导 | `orchestration.dispatchCommand` 的 `message.dispatch`，携带唯一 commandId；dispatchMode 表达真实阶段与目标 |
| 队列操作 | 编辑、排序、取消使用 `queued-run.*`；`queued-message.promote-to-steer` 原子消费队列项，保留目标原生轮次校验 |
| 停止/回答 | `thread.stop`、`runtime-request.respond`；请求 ID、有效状态和首个响应均由核心校验 |
| 计划转新会话 | 同一 launch 链路，继承授权范围并显式携带 `sourcePlanRef={threadId,planId}`；不能仅复制计划正文 |
| 历史与增量 | `orchestration.getThreadProjection`、`orchestration.subscribeThread` 及原生历史 HTTP 分页/搜索 |
| 工具详情 | `orchestration.getTurnItem`；列表的 `outputOmitted=true` 表示按需加载，不代表原始输出丢失 |

命令回执表示持久接受或确定错误，不代表模型已开始、引导立即生效或工具已完成。相同 commandId 由原生回执存储去重；外部调用结果未知时保持不确定状态，不自动重新推理。原生身份使用 providerThread/nativeThread/nativeTurn 的实际记录，业务层不修改 rollout 或拼接 transcript 冒充续接。

重连沿原生 sequence 补流、去重或校准快照，不能重新发送用户命令。网络连接恢复、恢复队列、继续一轮是不同动作。原进程上的请求在退出后失效；停止后必须等真实终态才结束执行状态。

## 工具与权限

`B/autoops/`（`vendor/t3code/apps/server/src/autoops/`）对 HTTP、RPC、流、附件、资源、用量及父子任务检查身份。`agent-demo/t3-adapters/access.mjs` 保存业务授权绑定；运行器只能使用当前授权线程注入的唯一 `t3-code` MCP server。

项目资料、附件读取、只读环境快照、提问、报告、受限 HTML 和已登记的资源采用成熟的原生 MCP 生命周期。环境数据当前明确标记为演示夹具。未知工具、宿主路径、任意网络、shell、任意文件写入和外部 Agent 注册均不开放；报告生成仍如实是写业务产物的工具。内部原生子任务继承父范围、固定模型和受限工具，并提供原生只读视图。

公开 reasoning 摘要直接进入原生工作记录。没有公开摘要时不生成“思考过程”；工具失败保存真实失败正文。Secret 和 MCP App 宿主代码保留，但当前没有相应业务注册/专用私密提交接口时不制造入口或假事件。CPA 未报告容量、价格、额度重置时间时保持未知。

## 状态与后续复用

- T3 核心拥有命令、回执、事件、投影、原生历史、上传和分页；AutoOps 不再存一份不断增长的 Conversation 快照作为新对话事实。
- 业务授权、ID 映射、个人偏好和报告独立于核心共享事实。置顶、归档、完成、暂时隐藏不会改变其他成员的执行状态。
- Edit from here 复用原生边界回退，外加共享影响确认及保护性 native fork/应用修订；未知结果继续冻结。恢复副本与普通可见分支分开。
- 导入只运行 Schema/EventSink/持久化层，不启动 provider/outbox。仅证据匹配的旧原生头可继续，其他旧会话保留只读历史和原因。
- 后续工作台复用完整 T3 客户端及核心协议，通过业务接口接入正式项目/用户/资料服务；扩大权限、外部 Agent 或真实写运维工具需另行需求设计。

构建、目录、数据切换、备份及无损回退边界见[部署与恢复说明](agent-demo-t3-deployment.md)。源码及依赖许可随发布包保存，来源差异清单与测试报告分别记录，不用复制文件数作为完成率。

## 使用入口

重新登录后从项目创建新会话，选择固定环境、Agent 和可见范围。执行中默认 Queue，可显式 Steer；`@` 选择授权资料，`/` 使用管理员开放的原生命令。技能目录为空时没有虚构技能。Plan 沿用上游开关：在 Settings → General → Legacy features 启用 Plan mode 后使用 `/plan`，计划的新会话执行仍受相同业务工具权限限制。

9 份迁入历史含 4 份原本已归档的会话，在 Settings 的归档列表恢复后再打开，保持上游归档流程。8 份旧历史因缺少可靠原生续接证明而只读，保留明确原因；需要新执行时创建新会话，不把旧 transcript 自动拼成新原生线程。
