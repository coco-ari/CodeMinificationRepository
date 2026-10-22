# Agent 交互 Demo：实现与验收契约

> 历史契约：下文描述迁移前的独立 Demo/SSE 链路。当前已按批准方案迁入 T3 完整对话模块，接口以 [T3 协议](agent-demo-t3-protocol.md) 和[迁移方案](agent-demo-t3-migration-plan.md)为准；新模式不继续执行下列旧会话 API。保留本文用于数据迁移和既有测试对账。

2026-10-21。用于本轮测试机验证；本文件不替代产品需求。沿用项目的 shadcn/ui、Solid Glass、项目/环境/内置 Agent 边界。Demo 使用独立入口 `/agent-demo.html` 和 `/api/agent-demo`，不把既有 localStorage 原型当成后端。

## 交付范围

- 桌面三栏：会话历史、对话与常驻输入、上下文/结果；手机抽屉。浅色安静界面，正文优先，工具详情按需展开，标题无装饰副标题。
- 项目、固定环境和固定内置 Agent；私有/项目共享会话由服务端授权。演示账号 admin、lin、chen，演示口令 `Demo123!`，与服务器系统账号无关。
- 发送、真实流式反馈、同轮引导、服务端排队及编辑/删除/排序、停止并暂停队列、继续、澄清、附件、引用、报告预览/下载、会话独立草稿。
- 页面关闭不取消运行；重连按序补齐、去重；服务重启不虚报运行中。执行错误保留部分结果和可恢复输入。
- 主任务是只读资料分析、环境查询和报告；不提供部署、数据库写入、机柜变更工具。
- `live` 是实际模型/运行器；`scenario` 是明确标识的可控交互场景，用于反复验证时序和故障，不得把场景通过当成真实模型验证。模型未就绪时如实禁用 live。
- 聊天交互直接适配 OpenChamber 的流式更新与滚动意图代码，采用 Hermes 的持续增量 Markdown 生命周期；通过 AutoOps 有序时间线接入现有 Grok/Codex bridge。上游精确版本、改动及 MIT 原文随 `/third-party/agent-demo-streaming-NOTICES.txt` 分发。
- 本轮进一步迁移输入/队列/思考/搜索/导出/完整轮次窗口与澄清草稿，补齐消息编辑后分支、从消息分支、重新生成、个人置顶归档和会话正文检索。具体源码归属及边界见 [迁移矩阵](agent-demo-open-source-flows.md)。

## API（JSON，使用 HttpOnly 会话 Cookie）

所有变更除登录外必须携带 `X-Demo-CSRF`（登录/bootstrap 返回）；发送、引导、停止、回答、继续操作携带 `requestId`，重复请求返回原结果。所有正文/文件/事件接口执行成员与会话权限校验。错误 `{error,code}`。

| 方法   | 路径（相对 `/api/agent-demo`）              | 输入与响应                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/login`                                    | `{username,password}` → `{user,csrf}`                                                                                                                                                                                                             |
| POST   | `/logout`                                   | `{}`                                                                                                                                                                                                                                              |
| GET    | `/bootstrap`                                | `{user,csrf,projects,agents,conversations,runtime:{liveAvailable,name,reason?},serverTime,eventCursor}`；列表仅可见会话                                                                                                                           |
| GET    | `/events?after=N`                           | SSE，持久序号 `id: N`；事件 `{seq,type,conversationId?,turnId?,payload,at}`                                                                                                                                                                       |
| POST   | `/conversations`                            | `{projectId,agentId,environmentId,visibility,mode,title?}` → `{conversation}`                                                                                                                                                                     |
| GET    | `/conversations/:id`                        | `{conversation}`                                                                                                                                                                                                                                  |
| PATCH  | `/conversations/:id`                        | `{title}` → `{conversation}`                                                                                                                                                                                                                      |
| PATCH  | `/conversations/:id/preferences`            | `{pinned?:boolean,archived?:boolean}` → `{conversation}`；仅当前用户偏好，不更改共享权限或执行状态                                                                                                                                                |
| POST   | `/conversations/:id/branch`                 | `{requestId,messageId,text?,expectedRevision?}` → 新私有 `{conversation}`；用户消息前截断并恢复草稿，传text则编辑后发送；助手消息保留完整轮次                                                                                                     |
| POST   | `/conversations/:id/retry`                  | `{requestId,turnId,expectedRevision?}` → `{conversation}`；只重试最新终态，保留原历史，执行上下文截在原输入前                                                                                                                                     |
| POST   | `/conversations/:id/queue/:itemId/send-now` | `{requestId,expectedRevision?}` → `{conversation}`；空闲时领取该项，不恢复其他暂停队列                                                                                                                                                            |
| DELETE | `/conversations/:id`                        | 活动轮次拒绝；成功 `{ok:true}`                                                                                                                                                                                                                    |
| POST   | `/conversations/:id/messages`               | `{requestId,text,attachmentIds:[],delivery,expectedTurnId?}` → `{conversation,receipt:{id,status,turnId?}}`；delivery 为 `send`、`queue` 或 `steer`；steer 必须 expectedTurnId 且轮次仍活跃；只有附件而无文字时明确显示默认输入“请分析所附文件。” |
| POST   | `/conversations/:id/stop`                   | `{requestId,expectedTurnId}` → `{conversation}`；暂停队列                                                                                                                                                                                         |
| POST   | `/conversations/:id/continue`               | `{requestId,turnId}` → `{conversation}`；用原轮次输入/附件和已生成结果开新轮次                                                                                                                                                                    |
| POST   | `/conversations/:id/queue/pause`            | `{requestId}` → `{conversation}`；暂停后续队列，不中断当前轮次                                                                                                                                                                                    |
| POST   | `/conversations/:id/queue/resume`           | `{requestId}` → `{conversation}`                                                                                                                                                                                                                  |
| PATCH  | `/conversations/:id/queue/:itemId`          | `{text}` → `{conversation}`                                                                                                                                                                                                                       |
| DELETE | `/conversations/:id/queue/:itemId`          | → `{conversation}`                                                                                                                                                                                                                                |
| POST   | `/conversations/:id/queue/reorder`          | `{ids:[所有当前队列ID]}` → `{conversation}`                                                                                                                                                                                                       |
| POST   | `/conversations/:id/questions/:questionId`  | `{requestId,answer,expectedTurnId}` → `{conversation}`                                                                                                                                                                                            |
| PUT    | `/conversations/:id/draft`                  | `{text,attachmentIds:[],revision}` → `{draft}`；仅当前用户草稿                                                                                                                                                                                    |
| GET    | `/conversations/:id/draft`                  | `{draft:{text,attachmentIds,revision}}`                                                                                                                                                                                                           |
| POST   | `/conversations/:id/attachments`            | `{name,mime,data:base64}`，≤8MiB/文件 → `{attachment}`                                                                                                                                                                                            |
| GET    | `/files/:id`                                | 授权后的原文件下载/文本；`?inline=1` 预览                                                                                                                                                                                                         |
| GET    | `/projects/:id/documents/:documentId`       | `{document:{id,name,content,mime}}`                                                                                                                                                                                                               |
| GET    | `/health`                                   | 无敏感字段的存活状态                                                                                                                                                                                                                              |

## 数据形状

时间使用 ISO。ID 为不透明字符串。所有 API 返回会话时含最新 `revision` 和 `eventSeq`。

```
User {id,name,username,role}
Project {id,name,memberIds,environments:[{id,name}],documents:[{id,name,mime,excerpt}],resources:[{id,name,type,environmentId}]}
Agent {id,name,description,projectIds,capabilities:['read','report','steer']}
Conversation {
 id,title,projectId,agentId,environmentId,visibility:'private'|'project',ownerId,
 mode:'live'|'scenario',createdAt,updatedAt,revision,eventSeq,queueRevision,
 status:'idle'|'running'|'waiting'|'stopping'|'failed'|'interrupted',
 activeTurnId:null|string,queuePaused:boolean,pinned:boolean,archived:boolean,
 branchedFrom?:{conversationId,messageId},
 messages:Message[],turns:Turn[],queue:QueueItem[],artifacts:Artifact[]
}
Message {id,role:'user'|'assistant',kind:'prompt'|'steer'|'answer',content,turnId,status,createdAt,attachments:Attachment[],actorName?}
Turn {
 id,status:'running'|'waiting'|'completed'|'interrupted'|'failed',
 inputMessageId,assistantMessageId,startedAt,completedAt?,
 steps:[{id,name,status:'running'|'completed'|'failed',input,output,startedAt,completedAt?}],
 question:null|{id,prompt,options:string[],status:'pending'|'answered',answer?},
 guidance:[{id,text,status:'sending'|'accepted'|'failed',createdAt}],
 timeline:[{id,type:'text'|'reasoning'|'tool'|'question'|'user',text?,itemId?,kind?,status?,stepId?,question?,messageId?,createdAt,updatedAt?}],
 phase?,lastActivityAt?,usage?,retryOfTurnId?,error?,runnerThreadId?,runnerTurnId?
}
QueueItem {id,text,attachments:Attachment[],createdAt,actorName}
Attachment {id,name,mime,size,url}
Artifact {id,name,mime,size,url,content?,createdAt,turnId}
```

## 事件与前端状态

- `conversation.updated`：`payload:{conversation}`，包含状态、工具步骤、问题、队列或文件的变更；快照最新 eventSeq 之前的增量不重复应用。
- `message.delta` / `reasoning.delta`：`payload:{messageId,delta,revision,timelineDelta:{id,type,itemId,createdAt,updatedAt,offset,delta,mode:"append"|"replace",kind?,status?},phase,lastActivityAt}`。客户端按 seq 去重并核对 offset，思考不混入助手正文。缺口冻结后续增量，补读快照达到已观察序号；请求失败退避重试。保留旧 timelineEntry 回放兼容；正常每token不拉整份历史。
- `turn.usage.updated`：`payload:{usage,revision}`，usage为会话累计及可选last快照，未知字段null，不能累加多次快照。
- `conversation.deleted`：删除列表/当前视图；清理仅该用户该会话草稿。
- `runtime.updated`：`payload:{liveAvailable,name,reason?}`。
- `ready`：服务端已建立连接，可显示已连接。网络断线保留内容与草稿，自动重连，不乐观宣称发送成功。
- 首次 bootstrap 的 `eventCursor` 与快照同一时点取得；前端等待 bootstrap 完成后从该游标建立 SSE，不重复回放全部历史。断线重连使用已收到的游标。
- 队列变更以 `queueRevision` 记录最近修改；`expectedRevision` 不得早于该值，普通正文增量不会造成队列编辑冲突。
- bootstrap/read 的快照可能比流更新旧：按 revision/eventSeq 拒绝过期写回。提交等待服务端确认再清除所提交的匹配草稿；迟到回包不清除新草稿或别的会话输入。
- 中文输入法组合期间 Enter 不发送；桌面 Enter 默认发送/排队、Shift+Enter 换行；手机 Enter 换行。忙时明确显示“引导本轮”“排队”及独立停止按钮。
- 上翻和展开工具后保持阅读锚点；回到最新才恢复跟随。离开会话保存位置与个人草稿，返回恢复。流式消息不能不断重新挂载整棵时间线。

## 本轮验收证据

1. 真实模型三个业务场景；记录运行器版本、输入、工具记录、引导回执和最终文件。
2. 发送/引导/队列/停止/澄清的幂等与竞态；控制场景至少100次并发/边界检查，关键路径另用真实模型复验。
3. 浏览器关闭/重连、服务重启恢复；零重复消息、零错误会话归属；停止确认后无继续正文、队列保持暂停。
4. 私有/共享/跨项目/文件/SSE越权测试与只读工具边界。
5. 390/768/1280/1920布局、长代码/表格、抽屉和预览、键盘与减少动态效果；截图实看，不仅断言存在。
6. 实测并报告请求确认、事件到显示和交互响应的样本数、p50/p95/max；LAN API接收p95目标≤500ms、界面交互反馈p95目标≤100ms。模型首字延迟单列。
7. 五会话并行与持续运行验证；证据索引将测试结果关联到具体版本/部署，不用旧原型测试替代。
8. 交付访问地址、账号、完整技术方案、部署/恢复说明、已验证和未验证边界。优秀体验同时通过实际逐屏审查，不用自动化绿灯代替主观结论。
