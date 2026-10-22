# T3 Code 与 AutoOps Agent Demo 对照

核查日期：2026-10-21。本次以实际运行的官方稳定版 **T3 Code v0.1.1** 为比较对象，源码固定为 [`fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`](https://github.com/pingdotgg/t3code/tree/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92)。此前调研的主分支提交 `7ffc3bb7` 不作为本次实测版本；例如主分支已拆分时间线组件，而 v0.1.1 的相关实现仍集中在 `MessagesTimeline.tsx`。

本文的“源码核查”和“适配建议”证明实现差异与可复用依据，不证明模型执行成功、页面体验更好或全部功能已迁入。真实操作、截图、时序和失败记录见本文后半部分。AutoOps 现有实现及过去验收分别见 [开源迁移覆盖](agent-demo-open-source-flows.md)、[验收记录](agent-demo-validation.md)；过去测试不能代替本次对照。

## 比较口径与配置边界

本次两端均接入 **Codex 0.159.2 / CPA / grok-4.6**，这减少了运行器和模型型号的差异，但不代表请求内容与执行条件完全一致。

部署测试对 v0.1.1 设置界面的观察是：**Response streaming = Show finished paragraphs，Follow-up = Queue**。这些是本次实际安装的界面设置；不能因为 `ComposerPrimaryActions` 或 `resolveComposerDispatchMode` 的缺省参数为 `steer`，就把“全局默认引导”写成产品事实。源码中的参数缺省值、用户设置和实际动作应分别核对。[发送模式逻辑][t3-dispatch] 支持按设置选择 queue / steer，并由 Ctrl/Meta 临时切换；不允许引导时回到队列。

当前比较还存在以下条件差异，测试结果需要一并记录：

| 条件 | 比较限制 |
| --- | --- |
| 推理设置 | T3 本次默认低 reasoning；未确认两端值一致前，不能直接把首字或整轮耗时差异归因于 UI。 |
| 工具与权限 | T3 使用原生代码工作区工具；Demo 关闭 shell、任意文件和网络访问，只开放项目资料、附件、只读环境查询、澄清及报告业务工具。工具次数与耗时并不相等。 |
| 系统指令与上下文 | T3 的系统指令、代码工作区和历史构造不同于 Demo 的项目授权目录、业务约束与上下文。相同用户提示也不会形成完全相同的模型请求。 |
| 后台请求 | T3 有后台标题生成等请求；对照需要识别这些请求，避免把后台耗时、用量或争用误算成正在观察的回答。 |
| 文字展示策略 | 本次 T3 使用完成段落后展示；Demo 也有流式分块提交。首个模型 delta、首个可见正文和完整段落可见是不同时间点。 |
| 历史与文件 | 两端必须使用各自新建的测试会话和相同的合成文件内容；不能用已经读过答案的旧会话对比新会话。 |

性能记录至少区分：提交反馈、服务接受、原生轮次开始、首个运行器事件、首个正文 delta、首段页面可见、执行结束。只能在同一链路中把“已收到正文但尚未展示”的时间归入前端展示等待；模型尚未输出时，页面只能呈现真实运行状态。不能用整轮更快直接证明 UI 更顺滑，也不能用等待动画掩盖模型延迟。

## 源码核查

### 执行中发送、排队与引导

T3 的队列有两个相互配合的层次：[QueuedRunsControl][t3-queue] 提供编辑、删除、排序和转引导；[threadWorkflows][t3-workflows] 根据活动 run、原生 turn 与运行器能力决定可用动作。队列项的转引导调用 `promoteQueuedRun`，同时传入 `queuedRunId` 和 `targetRunId`；Codex 适配器最后使用真实 `turn/steer`，附带 `expectedTurnId`。[原生引导实现][t3-steer]

AutoOps 已支持新输入直接选择引导或排队，但 [server.mjs](../agent-demo/server.mjs) 的 `/queue/:id/send-now` 调用 `requireIdle`，只允许空闲时提前发送某个排队项。**它不等价于 T3 的“将已排队消息转为当前执行的引导”**，这是一项确定的功能差异。

| 细节 | T3 的实现理由 | AutoOps 对应情况与适配方向 |
| --- | --- | --- |
| 转引导绑定目标轮次 | 请求途中当前轮可能结束；显式目标身份避免引导误投到新轮。 | 保留既有 `expectedTurnId` 校验，为队列提升增加一个服务端原子操作；成功确认后才移除队列项，不能在前端先删除再另发消息。 |
| 乐观队列按消息身份去重 | 服务端已接受的消息，即使已经取消或开始执行，也不能重新作为本地 pending 项出现。 | 迁入 `acknowledgedMessageIds` 判定，与现有请求回执一起验证；不能只检查“此刻还在队列”的 ID。 |
| 只有拖柄启动拖动 | 避免用户选择队列文字时意外改变顺序。 | Demo 当前提供上下移动；若采用 T3 拖动体验，应保留拖柄、忙碌保护及键盘可操作的排序入口。 |
| 能力和阶段控制 | 正在压缩、没有可引导原生轮次时，不显示可执行的引导动作。 | Demo 的静态 Agent capability 还需结合当前真实阶段；不能只凭“支持 steer”永久开放。 |

上述结论来自源码，转引导后模型是否遵循补充要求，仍必须看真实后续正文和工具执行；运行器接受请求不等于模型完成了指令。

### 正文、思考与工具记录

T3 v0.1.1 的 [MessagesTimeline][t3-timeline] 区分助手正文、实时工作项、工作组、提问/回答等记录。`WorkGroupSection` 对纯 reasoning 组使用思考轨迹展示；`LiveWorkEntryTimelineRow` 可组合思考摘要与当前工具状态，失败工具保留失败语义。工具展示由 [CodexToolPresentation][t3-tools] 等适配器根据真实类型和元数据生成。

Demo 已使用 OpenChamber 的活动收束、思考块、单层工具详情和文件预览，见 [turn-activity-model.js](../web/src/agent-demo/turn-activity-model.js)、[tool-parts.jsx](../web/src/agent-demo/tool-parts.jsx)。它并非没有工具或思考流程；应比较相同工具序列在执行中、完成后和展开后的可读性，避免只比较按钮数量或最终截图。

业务数据仍需要适配：T3 的文件工具通常指向工作区路径，Demo 的读取指向授权项目资料或会话文件 ID。可以沿用上游“工具标题、当前状态、折叠详情、结果入口”的呈现规则，但文件点击必须走本地授权预览；`create_report` 应保持交付报告的业务含义，不能伪装成原生文件写入。

正文渲染的路线也不同：T3 的 [增量 Markdown parser][t3-markdown] 在统一 Markdown 管线内缓存已闭合代码块前缀，遇到文档级引用定义等情况回退完整解析；Demo 的 [streaming-markdown.js](../web/src/agent-demo/streaming-markdown.js) 使用已有增量解析依赖直接追加 DOM。源码不能证明其中一种一定更快。比较应包含长代码、表格、未闭合围栏、终态补齐、复制和历史恢复；只有发现具体差异后，才决定是否替换整套渲染管线。

### 滚动、新轮锚定与长会话

T3 [时间线的 LegendList 配置][t3-list] 使用虚拟列表，并根据阅读、引用定位、折叠、新轮锚定等状态控制末尾跟随。[timelineScrollAnchoring][t3-scroll] 明确区分 `following-end`、`anchoring-new-turn`、`free-scrolling`，保存行 ID、行内偏移、滚动位置和展开状态；[工作组锚点函数][t3-anchor] 按实际滚动偏移定位行，减少虚拟列表可见范围缓存滞后造成的偏移。

Demo 的 [use-chat-scroll.js](../web/src/agent-demo/use-chat-scroll.js) 已区分用户阅读动作与布局变化，并在活动折叠时维护正文锚点；但普通会话位置主要保存 `scrollTop`。[use-history-window.js](../web/src/agent-demo/use-history-window.js) 首次只渲染最近 30 轮，向前展开后旧 DOM 不回收，服务端仍传完整会话快照。

因此，“两边都有自动滚动”不足以认为实现等价。T3 的虚拟列表、按行身份恢复、服务端历史分页是确定的结构差异；其 [历史分页策略][t3-history] 包含默认 10 轮、向前 20 轮及条目/字节预算，普通轮次中的工具活动不随意切断。这些是 UI 和传输历史策略，不是把模型上下文限制成 10 轮。

应在真实长会话中记录 DOM 数量、快照体积、切会话后的阅读位置、展开/收起时偏移和工具组内部滚动。受控滚动测试或少量轮次顺畅，不代表长历史已经达到相同能力。

### 用户提问与审批

T3 把待回答问题集成到输入区：[问题面板][t3-questions] 支持多问题进度、单选后短暂反馈再前进、数字键选择和不可恢复请求禁答；[输入区主操作][t3-primary] 随阶段显示上一题、下一题、提交答案和停止。模型问题、答案草稿与提交中状态分开保存，避免一次点击就丢失后续问题。

Demo 的 [codex-bridge.mjs](../agent-demo/codex-bridge.mjs) 当前把原生 `requestUserInput` 逐题转成自己的问题状态，仅把选项 label 传入，并将答案作为单个字符串返回。它能完成逐题澄清，但未完整保留上游问题组、选项说明和复杂选择结构。若真实体验确认需要迁入，应先扩充问题协议，再接入相同的导航与草稿流程，不能只复制前端表单。

T3 的 [审批面板][t3-approval] 和 [审批操作][t3-approval-actions] 支持命令、文件、权限及 MCP 等类别；原生进程消失时明确说明不能再回答。Demo 当前定位是受限只读助手：`approvalPolicy: never`、原生命令/文件写入请求直接拒绝，只开放业务工具白名单。**审批入口不同属于当前产品边界，不能为了视觉一致而扩大 Agent 权限。** 将来接入业务写操作时可复用请求展示、一次性回答和失效处理，但审批范围与执行授权须由业务服务定义。

### 停止、重启与恢复

T3 使用原生 `turn/interrupt`，由 [`turn/completed` 通知][t3-completion] 处理实际终态；中断 HTTP/RPC 已返回不等于执行已经结束。[ProviderRuntimeRecoveryService][t3-recovery] 在启动/关闭恢复时处理旧的执行记录、把队列置为 hold，并让绑定旧进程的审批请求变为 expired/cancelled、`not_resumable`；继续执行由单独策略决定。

Demo 也已实现原生中止、持久 thread 映射、重启旧轮标记中断、队列暂停和明确的“继续”。不能把这部分记为完全缺失，也不能把两端都能 `thread/resume` 说成恢复了断电前进程内部位置。比较需要检查停止后的尾部增字、重复点击、等待提问时停止、重启后旧问题是否可误提交，以及用户继续前队列是否启动。

上游自动准备继续执行的策略不是必须原样启用的 UI 功能。AutoOps 的只读任务和未来发布/迁移等写操作有不同执行后果；应保留明确的恢复策略，不因迁入组件悄悄自动重跑业务操作。

### 重复事件、重连与数据规模

T3 的 [CommandReceiptStore][t3-receipts] 保存 commandId、接受/拒绝状态及 resultSequence；[客户端投影][t3-sequence] 按已应用序号跳过重复事件。[ThreadStream][t3-stream] 在重放超过 128 个事件或 1 MiB 等条件下选择有界快照，而不是无上限回放。[ThreadLiveEventCoalescer][t3-coalesce] 在 50ms 窗口中合并同一运行中工具的替换更新，遇到其他事件先冲刷，保留终态和事件边界；这不是任意删除正文 delta。

Demo 的 [use-demo.js](../web/src/agent-demo/use-demo.js) 已有全局及会话序号去重、动画帧批处理、缺失记录修补和重连快照校准，服务端也有请求幂等。确定差异在于目前仍大量保存/传输完整会话快照，缺少上游有界历史与专门投影结构。此前清理测试遗留缓存释放了磁盘，不代表自动保留周期或数据增长问题已经修复。

适配时应优先借鉴“命令回执只存结果身份/序号、事件与投影分开、有界重放与快照回退”的结构，并保留 AutoOps 的项目鉴权、分支边界和删除通知。不能为减少数据库体积直接清空仍被分支和重连使用的历史事件。

## 适配建议

本轮先完成实际对照与证据归档，不把下面的建议写成已经迁移的功能，也不把 T3 所有代码工作区功能都加入 AutoOps 的第一阶段。

许可已按固定版本的 [LICENSE][t3-license] 核实：T3 Code 自有源码为 MIT，版权声明是 `Copyright (c) 2026 T3 Tools Inc.`。后续复制或适配实质源码时，需要随分发保留该版权声明和完整 MIT 许可文本；源文件同时记录上游路径、固定提交和本地适配范围。本次完成了源码分析与独立运行对照，尚未将 T3 实现加入 Demo。T3 的依赖、字体、图标和其他资产还可能有各自许可，不能用根目录 MIT 替代；实际带入的部分应逐项纳入本项目第三方声明。上游已有[按分发内容收集许可的实现说明][t3-license-notices]，可复用其清单方式，不必把未迁入的整个上游依赖清单照搬过来。

| 复用范围 | 可复用内容 | 需要的适配与原因 |
| --- | --- | --- |
| 纯逻辑和规则 | 发送模式判定、队列能力判断、排序、阅读锚点计算、重放预算、工具更新合并及相关测试场景。 | 映射 AutoOps 的 turn/message/part ID 与事件类型，保留上游来源与许可；不要仅模仿外观重新实现相同算法。 |
| 队列交互 | 编辑、拖柄排序、乐观消息去重、排队转引导和快捷键反馈。 | 转引导需要服务端原子命令与真实运行器回执；保留队列附件身份、权限、版本冲突和预期轮次校验。 |
| 整体时间线 | 类型化正文/工作项、虚拟列表、折叠状态和阅读位置恢复。 | 按完整模块适配现有 turn/part 数据，不能只复制零散 scroll 回调；业务工具、文件预览和报告入口通过适配层接入。 |
| 用户问题 | 问题组导航、答案草稿、快捷键、提交和请求失效反馈。 | 先保留完整问题协议，再迁移 UI；旧请求的能力与当前活动轮次必须由服务端确认。 |
| 基础组件 | 上游布局、状态、焦点和键盘交互。 | T3 v0.1.1 的 [Button][t3-button] 和 [Menu][t3-menu] 使用 Base UI；本项目要求现有 shadcn/Radix 与 Solid Glass。转换组件 API，不替换整套基础组件与主题。 |
| Markdown | 已验证有收益的分块呈现或增量解析行为。 | 当前已有成熟增量解析依赖；先找具体失败场景，再判断是否迁入完整管线，避免混搭造成链接权限、代码复制和终态不一致。 |
| 工具与权限 | 请求展示、工具状态、结果展开、一次性响应和失效处理。 | 保留项目/环境/成员授权和按 ID 读取资料，不能把工作区路径权限当成业务数据权限，也不为一致性开放全权 shell。 |

建议优先检验并处理的顺序：已排队消息转引导；输入区问题组体验；时间线虚拟化及阅读位置；有界重放和历史分页。思考/工具外观与 Markdown 的改动应由本次实际观察确定，避免再次只迁入片段、未验证完整生命周期。

## 真实对照记录

### 部署与执行范围

T3 Code 独立部署在测试虚拟机的 `/home/tao/t3-code-comparison`，使用独立工作目录、Codex home、数据库和用户服务 `t3-code-comparison.service`，入口为 `http://172.29.22.6:8795`（需要一次性设备配对）。原 Demo 继续使用 `8787`，桥接服务仍为 `8791`。两端串行调用原有 CPA / Grok，避免对照请求互相争用；没有修改原 Demo 的产品代码、模型配置或用户会话。

基础场景实际执行 **T3 10 个原生轮次、Demo 9 个原生轮次**；每端各有一次计划内主动停止，其余轮次完成。T3 另追加一次滚动复核，单独记录。T3 的“排队转引导”取消了一个尚未执行的队列占位 run，它没有启动模型，不计为失败轮次。后台标题请求不算对话轮次。

两个新会话使用相同随机口令、颜色、两行 TXT 和用户提示。T3 从独立工作目录读取文件，Demo 使用网页上传附件；这是接入方式差异。T3 的命令审批由测试者确认，人工停留时间不计 UI 性能。T3 权限设为 Supervised；Demo 保留业务工具白名单。T3 首轮原生输入约 3.84 万 tokens，Demo 长文轮输入约 5883 tokens，系统指令与工具集明显不同，不能把总耗时当作前端优劣排名。

### 已验证行为

| 场景 | T3 Code 实测 | 当前 Demo 实测 | 结论 |
| --- | --- | --- | --- |
| 跨轮记忆 | 原始口令、颜色正确；同一个原生 thread。 | 同样正确；同一个原生 thread。 | 基础连续会话均成立。 |
| 首次及历史文件读取 | 分别实际执行 `head`、`sed`，两行内容正确。 | 两轮均实际调用 `read_attachment`，内容正确。 | 两端都有真实读取，不能把普通文字复述算工具执行。 |
| 长文、表格、代码 | 正文、5行表格、闭合 JSON 与结束标记完整。 | 同样完整，未见重复 part。 | 本轮没有证据支持立即替换 Demo 的 Markdown 管线。 |
| 执行中引导 | 已排队输入经真实 `queued-message.promote-to-steer` 转入当前原生轮次。 | 直接选择“引导当前执行”被接受，原生 turn 未变。 | T3 多了“已排队再转引导”的完整路径；Demo 应优先适配。 |
| 排队顺序 | 原 run 6 完成后约192ms才启动剩余排队 run 8。 | 当前轮完成后约5ms启动排队下一轮。 | 两端顺序正确，以上间隔不是性能排名。 |
| 引导后的模型行为 | 先输出原12段草稿，再追加3段收尾和 `STEER-ACK`。 | 同样先原稿、再追加3段收尾。 | 接受引导不等于立即中止或重写已经生成的内容。 |
| 输出中停止 | 约0.15秒收到中断终态；最终批次提交后3秒不再增长，旧正文保留。 | 约0.26秒确认中断，保留138字符，1秒复查无增长。 | 两端停止有效；采样窗口不同，不据此排名。 |
| 停止后准确续写 | 已有1–4段，续写却编号18–20。 | 已有1、2段及第3段开头，续写重新编号1–3并重述前置检查。 | 两端均未满足“从最后完整段落继续”；不能宣称恢复完全通过。 |
| 连接恢复 | 运行中施加约5秒离线并显式关闭 WebSocket；恢复连接后同一原生轮次继续完成。 | 本次不重复断网；以前的受控证据单列，不算本次实测。 | 本轮不能做两端断网速度排名。 |
| 完成后刷新 | 末条助手消息 ID 和可见正文一致，没有观察到新增原生轮次。 | 消息 ID、轮数、末轮正文一致，无重复 part。 | 可见历史恢复成立；T3 本次未另取得权威服务端最终正文快照，不能扩大结论。 |
| 390px 移动视口 | 无页面横向溢出；折叠输入条可真实展开、输入，按钮在视口内。 | 无横向溢出，输入区及发送按钮可见。 | Chromium 仿真通过，不代表实体手机或软键盘已验收。 |

T3 的基础十轮与 Demo 九轮正文未观察到此前出现的 `<|…|>` 控制标记。这个有限样本不能推翻此前长会话中的异常，也不能宣称 CPA/Grok 协议问题已修复。

### 滚动与流式的测量边界

Demo 已确认真实上翻约420px、离底407px；持续输出期间观察3.4秒，阅读锚点最大漂移0px。点击“回到最新消息”成功，最终离底13px。T3 首次滚动测试只证明发出了 wheel，没有证明成功离底，因此其 `anchorStable=false` 记为 **不确定**，不记产品抢滚动缺陷。上游实际存在 `Scroll to end`，首次脚本仅匹配 `latest|bottom` 漏掉了它；按轮次跳转的 minimap 是独立功能。[返回末尾实现](https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/ChatView.tsx#L8337)

追加复核捕获了可信的向上 wheel，确认命中时间线；此后主时间线停止追尾，`scrollTop` 维持3966，新增正文使离底距离增至911px，`Scroll to end` 出现；在追加轮已经结束后真实点击，动画结束后离底0px。但逐帧记录仍没有证明一次实际向上位移，所以“上翻后稳定锚点”的完整场景仍不判通过。此记录证实执行中取消自动跟随和终态回到末尾入口可工作；没有验证执行中点击后恢复持续跟随。保留测量边界，不覆盖原始记录。

首字和流式延迟不能简单横比：T3 的 WS 正文到达时间从测试提交前起算，DOM 时间从实际点击起算，基线相差约14–20ms；首次文件读取的 DOM 观察器曾被未发送草稿替换，指标作废。Demo 的 `firstPayloadMs=null` 是测试观察器只监听具名 SSE 事件、漏掉默认 `message` 事件造成的测量缺失；真实前端有默认消息处理，持续正文提交已确认，不能解释成没有流式输出。

例如 Demo 长文轮约10.4秒出现运行器首正文、约12.4秒出现浏览器可见正文：前面的生成等待与后续桥接、传输、段落提交应分开分析，当前记录不足以把约2秒差额全归给 UI。排队轮的首字时间还包含排队等待；包含活动折叠和零字数变化的提交间隔不能当成逐 token 流畅度指标。

### 异常和验收限制

- T3 历史文件轮出现模型报告“参数必须是整数”的推理摘要，随后正确执行命令。未捕获首次非法请求原文，不能据此认定具体错误参数或 T3 UI 故障。
- T3 离线窗口5010ms内仅收到1个边界 Pong，0业务事件、0正文更新。关闭调用使旧 socket 进入 CLOSING；恢复网络后22ms才确认 Closed，28ms创建新连接。这证明显式断开后的恢复，不证明自动断网检测超时或离线瞬间完成关闭握手。
- 移动端初次选择了隐藏的桌面编辑器，得到0尺寸并误报失败；后续真实点击 `Expand composer`、展开输入及清空测试草稿均通过，未发送新模型消息。原始失败报告保留，另有纠正报告。
- 未覆盖百轮真实长历史、并发压力、多问题整组作答、队列拖动排序、真实手机软键盘以及本次两端对称的服务进程崩溃恢复。虚拟列表、历史分页、请求失效等相关结论目前是源码核查，不冒充实测通过。

### 本次判断与迁移顺序

**T3 更适合作为后续统一的交互参考；当前 Demo 的基础流程已能运行，差距集中在交互完整性和长历史结构。** 不能根据本次有限样本宣称 T3 所有体验都更好，也不应把同样存在的模型续写错误当成更换 UI 就能解决的问题。

1. 首先适配 T3 的完整发送与队列流程：直接引导、排队、队列转引导、编辑与排序、快捷键及运行阶段能力。队列转引导需要服务端原子命令和目标轮次校验，不能前端删掉队列再发一条消息。
2. 随后整体适配时间线：工作项收束、阅读位置、虚拟列表及历史分页一起迁入。保留 AutoOps 的文件 ID、项目权限、资料预览与报告入口，通过类型适配器连接上游表现层。
3. 采用其有界重放、事件合并、命令回执和投影策略，解决历史与磁盘增长；清理一次测试缓存不等于完成保留策略。
4. 多问题导航和审批失效流程先补真实验收，再迁移对应交互。停止后准确续写、引导生效时机继续在 Codex/CPA/Grok 链路验证，不以隐藏错误正文的方式解决。

继续遵循本项目 shadcn/Radix 与 Solid Glass 约束，适配 T3 的 Base UI 组件 API；源码迁入保留上游来源、MIT 许可及相关测试。普通 Markdown 渲染本轮通过，暂不为更换实现而重写。

### 本地证据

- [T3 原生事件与轮次报告](../.test-artifacts/t3-comparison-20261021/t3-report.json)
- [T3 排队转引导记录](../.test-artifacts/t3-comparison-20261021/t3-queue-interaction.json) · [队列界面截图](../.test-artifacts/t3-comparison-20261021/t3-queue-two.png)
- [T3 滚动追加复核](../.test-artifacts/t3-comparison-20261021/t3-scroll-recheck-interaction.json) · [返回末尾截图](../.test-artifacts/t3-comparison-20261021/t3-scroll-recheck-return-end.png)
- [T3 停止记录](../.test-artifacts/t3-comparison-20261021/t3-stop-interaction.json)
- [T3 连接恢复](../.test-artifacts/t3-comparison-20261021/t3-recovery-interaction.json) · [离线窗口分析](../.test-artifacts/t3-comparison-20261021/t3-recovery-offline-window.json)
- [T3 移动端复核](../.test-artifacts/t3-comparison-20261021/t3-mobile-followup.json) · [展开输入截图](../.test-artifacts/t3-comparison-20261021/t3-mobile-followup-expanded.png)
- [Demo 九轮报告](../.test-artifacts/t3-comparison-20261021/demo-2026-10-21T09-34-50-641Z.json) · [长文截图](../.test-artifacts/t3-comparison-20261021/demo-2026-10-21T09-34-50-641Z/round-5-stream_scroll.png)

原始测试证据位于本地忽略目录，未提交仓库；Demo 仅删除本次新建测试会话，原用户会话和附件保留。T3 保留独立测试实例供继续体验。本文未包含配对凭据或 CPA Key。

[t3-dispatch]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/packages/client-runtime/src/state/composerDispatch.ts#L4
[t3-queue]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/QueuedRunsControl.tsx#L100
[t3-workflows]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/packages/client-runtime/src/state/threadWorkflows.ts#L125
[t3-steer]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6813
[t3-timeline]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/MessagesTimeline.tsx#L3329
[t3-tools]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/provider/CodexToolPresentation.ts#L145
[t3-markdown]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/markdown-incremental.ts#L33
[t3-list]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/MessagesTimeline.tsx#L1516
[t3-scroll]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/timelineScrollAnchoring.ts#L40
[t3-anchor]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/packages/client-runtime/src/work-log/scrollAnchor.ts#L2
[t3-history]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/threadHistoryPaging.ts#L13
[t3-questions]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx#L96
[t3-primary]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L178
[t3-approval]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx#L65
[t3-approval-actions]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/chat/ComposerPendingApprovalActions.tsx#L28
[t3-completion]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6122
[t3-recovery]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L321
[t3-receipts]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/CommandReceiptStore.ts#L44
[t3-sequence]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/packages/client-runtime/src/state/threads.ts#L432
[t3-stream]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/ThreadStream.ts#L14
[t3-coalesce]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts#L18
[t3-button]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/ui/button.tsx#L3
[t3-menu]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/web/src/components/ui/menu.tsx#L3
[t3-license]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/LICENSE
[t3-license-notices]: https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/docs/internals/open-source-licenses.md
