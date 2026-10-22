# Agent 对话流程的开源迁移覆盖

核对日期：2026-10-21。本文按用户一次完整对话的路径记录源码覆盖、迁移方式和验收边界；不是上游全部功能清单，也不表示某台服务器已部署本文全部变更。部署版本及真实模型证据以 [验收记录](agent-demo-validation.md) 为准。

参考版本固定为 [OpenChamber `6491f51d`](https://github.com/openchamber/openchamber/tree/6491f51dbcf05d1e3f7f823049f5f097c96c234b) 和 [Hermes WebUI `3aa21f63`](https://github.com/nesquena/hermes-webui/tree/3aa21f63387939dcff37baa141ad59a0e1e1147f)。二者为 MIT；复制、适配的源文件头保留来源，许可随前端分发，见 [第三方归属](../web/public/third-party/agent-demo-streaming-NOTICES.txt)。运行器仍使用当前 Codex App Server / CPA 配置，未把 OpenCode 或 Hermes Agent 的运行器直接换入。

## 本次纠偏：以 OpenChamber 为单一展示基准

用户 2026-10-21 的“整理一份发布准备报告”轮次包含 12 段时间线：5 次工具调用、3 段模型思考、3 段过程文字和1段最终答复。两次读取分别是《环境检查手册.md》和《工作台设计与边界.md》。原实现虽复用了滚动/Markdown 等片段，工具区域仍是自制 `Steps` 嵌套 Accordion，而且缺少上游整轮 Activity 收束，不能称为完整交互迁移。

本次直接拉取并读取固定版本源码后，取消上述自制展示。以 **OpenChamber `6491f51d`** 的对话呈现规则为准；Hermes 仅保留已接入的增量 Markdown 解析器生命周期，不再把不同项目的工具/思考 UI 拼接成新流程。

| 上游源文件                                                                                                                            | 迁移到本地                                                        | 本次行为                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `components/LiveTurnActivity.tsx`、`LiveActivityCollapse.tsx`、`lib/turns/activityRows.ts`、`useActivityRowGlide.ts`、`holdAnchor.ts` | `turn-activity.jsx`、`turn-activity-model.js`、vendor helpers     | 活动运行时默认最近7行；展开看全部；最终答复完成后收起中间文字/工具/思考；保留手动打开状态及阅读位置。             |
| `parts/ProgressiveGroup.tsx::StaticToolRow`                                                                                           | `tool-parts.jsx`                                                  | 每次读取仍是一行，显示文件名并直接预览；上游没有合并多次 read，本地也不擅自合并。                                 |
| `parts/ToolPart.tsx`、`toolRenderers.tsx`、`toolHelpers.ts`                                                                           | `tool-parts.jsx`                                                  | 自定义业务工具单层展开，直接输入和输出；删除“步骤 → 参数与结果”双层。报告保留业务名称，不伪装为本机文件写入。     |
| `JsonSummaryView.tsx`、`JsonTreeViewer.tsx`、`jsonTreeUtils.ts`、`BlockLine.tsx`、`MinDurationShineText.tsx`                          | `vendor/openchamber/tool-parts/`                                  | 直接迁移结构化结果/JSON树/原文展示、复制与大树虚拟列表，保留许可。                                                |
| `parts/ReasoningPart.tsx::ReasoningTimelineBlock`、`busy-dots.tsx`、`useDurationTicker.ts`                                            | `vendor/openchamber/reasoning/`、`reasoning.jsx`                  | 直接迁移展开状态、动画、摘要与嵌套滚动。删除自加的思考秒数和复制条；流式折叠时不显示摘要。                        |
| `lib/streamTextCommit.ts`                                                                                                             | `vendor/openchamber/reasoning/streamTextCommit.ts`、`Content.jsx` | 按已完成块揭示流式文字，长尾按上游阈值释放，终态冲刷尾段。思考只做一次提交，避免双重缓冲。                        |
| `parts/WorkingPlaceholder.tsx`、`hooks/useAssistantStatus.ts`、`ScrollToBottomButton.tsx`                                             | `work-status.jsx`、`Chat.jsx`                                     | 真实阶段工作状态最少保持1200ms；上翻时并入回到最新按钮；澄清/停止不额外堆状态；无自制计时、静默阈值或长等待提示。 |

必要协议适配：AutoOps 的授权文档/文件 ID 替换 OpenCode 本机路径；预览仍使用权限校验。Codex 的真实 `agentMessage.phase` 映射为 `messagePhase`，缺失不编造；历史完成轮次才允许末尾正文回退。用户引导仍保留原消息位置；待回答表单不被7行裁剪隐藏。运行器、项目权限和业务工具未替换成 OpenCode SDK；未将不存在的 Git/diff/终端能力画成可用控件。

验证包括用户原轮只读副本回放、控制事件整页回归、工具数据大树/移动端检查。每次部署以 [验收记录](agent-demo-validation.md) 的具体资产摘要为准；不能拿此前测试通过推导本次视觉一致。

## 迁移方式

- **直接复制适配**：实际提取上游算法、状态分支或组件代码，再替换本项目数据和 shadcn/ui 组件；不等于整文件照搬。
- **按流程改编**：沿用上游交互语义，在 AutoOps 的权限、轮次、幂等和 SSE 协议上重新接线。
- **已有能力**：本项目此前已实现，本轮保留或补齐；不追溯声称由上游复制而来。
- **不适用本轮**：依赖另一套运行器、超出已确认产品范围，或应另立需求。缺失的通用交互另列为待补，不以“不适用”掩盖。

## 真实测试暴露的问题：修复依据与可复用边界（2026-10-21）

此前真实测试已发现旧附件第二轮无法读取、PDF 无正文、第 102 轮触发 200 条历史限制、运行器重启后就绪状态失真，以及终态布局可能打断“回到最新”。下面记录本次源码修复的依据，不表示部署后真实 Grok 验收已经完成。上游“好用的原因”是源码行为分析；性能与体验仍需对应版本的测试证据。

| 问题                                       | 上游为什么这样处理                                                                                                                                                                               | 本地不能直接照搬的部分                                                                                                                                    | 本次复用及适配                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 下一轮找不到附件                           | Hermes `api/upload.py` 将上传内容保存在会话附件目录；`api/streaming.py::_build_native_multimodal_message` 将非图片保留为可被 Agent 文件工具读取的路径。文件身份不会随一轮结束消失。              | AutoOps 文件位于带会话权限的 SQLite 中；没有可交给运行器任意读取的用户工作区路径。把所有旧文件正文每轮塞进请求还会放大请求和上下文。                      | **按流程改编**：主服务保存稳定文件 ID 与提取缓存，向 Bridge 提供当前附件和历史附件目录，正文通过固定内部读取端点按需取得。每次读取重新验证活动 run、会话、发布状态和轮次边界，未发送草稿、外会话及未来队列文件不进入目录。                                                                             |
| PDF 上传成功却不能读                       | OpenChamber `sync/attachment-files.ts` 显式检查模型输入模态，并把 PDF 交给 OpenCode；Hermes 的 WebUI 不自建 PDF 解析器，非图片交给运行器文件能力。                                               | 当前业务工具没有上游完整文件工具，也不能因浏览器能预览 PDF 就宣布模型已读。                                                                               | **成熟依赖复用 + 运行器适配**：`attachments.mjs` / `attachment-pdf-worker.mjs` 使用 Mozilla `pdfjs-dist@6.4.299` 的 `getDocument/getTextContent`，生成可缓存文字及页码；不自写 PDF parser。上传返回 `readable/extraction`，读取工具沿用同一能力结果。                                                  |
| 短对话累积到固定轮数失败、每轮重复准备历史 | OpenChamber `lib/opencode/client.ts::sendMessage` 对同一个 `sessionID` 发送增量输入；`compactSession` 把压缩交给运行器。工具结果和上下文属于会话，页面不是另一个对话引擎。                       | OpenCode SDK 与现用 Codex App Server 的方法、事件、权限协议不同，不能复制 SDK 调用即视为适配完成。                                                        | **按运行器协议改编**：`runtime-sessions.mjs` 保存会话与原生 thread 映射、上下文版本及授权指纹；Bridge 使用 `thread/start`、`thread/resume` 和 `turn/start`。已有原生会话只送本轮输入，取消 200 条历史计数门槛；首次导入或显式重建才导入可见历史。压缩使用运行器原生能力，不新增自制摘要。              |
| 重启后界面显示可用，马上发送却失败         | OpenChamber 服务端 `lib/opencode/health-wait.js` 在有请求时等待真实健康检查，支持取消及有界等待；进程存在不等于运行器已就绪。                                                                    | 主服务和 Bridge 分成两个进程，旧的成功健康结果不能代表重启后的新实例。                                                                                    | **原代码复制 + 探针适配**：原样复制 `health-wait.js` 为 `agent-demo/vendor/openchamber/health-wait.mjs`，随附 MIT 许可；主服务接入 Bridge 的就绪探针并合并并发检查。协议层仍需确认当前运行器、模型与工具权限，恢复失败保留输入而不悄悄新建空上下文。                                                   |
| 回到最新后又停住、读到一半的回答终态跳位   | OpenChamber `hooks/useChatTimelineScroll.ts` 以真实滚轮、触摸、按键和滚动条操作表达退出跟随；`messageViewportAnchor.ts` 用消息身份与视口偏移保存阅读位置，`holdAnchor.ts` 在布局变化期间保持它。 | 本地没有上游虚拟列表，Activity 收起时会把同一正文移动到另一 DOM 容器；浏览器可能先把 `scrollTop` 钳到 0。单看一次 scroll 位移会把布局变化误判成用户上翻。 | **已有原算法 + DOM 适配**：`use-chat-scroll.js` 不再因纯布局上移退出跟随；`turn-activity.jsx::ActivityAnswerAnchor` 在 React 更新前记录正文 part ID 与位置，更新后复用既有 `holdAnchor`；`LiveActivityCollapse` 依据更新前的位置决定视口外即时收起。未另建一套滚动引擎，也未照搬不适用的虚拟列表 API。 |
| 长文首段等待不稳定                         | 上游界面根据真实运行器事件显示状态与正文，前端不能制造提供方尚未产生的内容。持久会话可减少重复上下文准备，但不能保证固定首字延迟。                                                               | 一次等待包含主服务准备、thread 就绪、模型／工具执行和浏览器提交；只看最终总时长无法定位问题。                                                             | **事件适配**：记录运行器就绪、首事件和首正文等实际时点，继续使用上游块提交和终态冲刷。不能以增加假进度或假打字来宣称长等待已解决；真实模型的修复前后比较另记验收报告。                                                                                                                                 |

文件解析与权限、运行器会话与 UI 历史分别独立：日后自研项目可以复用附件能力结果、按需读取端点和原生会话适配协议，而不依赖这份 Demo 的页面或数据库布局。新增运行器须映射相同的会话、终态、工具读取和权限语义；不能仅让它返回字符串。

能力边界：PDF 提取上限为 8 MiB、100 页、50 万字符和 10 秒；超时终止独立 worker。仅允许解析器读取安装包内资源，不访问 PDF 指定的 URL 或任意本机路径。扫描／无文字层、密码保护、损坏和超限文件明确不可读；混合文档标明未读页，本轮不做 OCR。Office 正文解析仍未实现。图片使用原生视觉输入，历史图片目录不重复发送像素；需要重新视觉分析时明确要求重附，不把图片 metadata 当成正文。

持久 thread 是上下文延续，不是让断电前正在执行的那一轮原地复活。已中断轮次仍保留可见内容并由用户继续；恢复映射缺失、未确认写入或恢复失败时显式报错。权限缩减会隔离旧上下文，不能把旧工具结果重新带入；分支与重试仍按业务边界重建。传输大小、模型上下文窗口、运行器自动压缩和服务端全量历史快照仍有各自限制，不能称为无限长对话。

本次受控证据：`node --test test/agent-demo-attachments.test.mjs` 的 13 项字节级解析检查通过；[会话附件 HTTP/SQLite 检查](../.test-artifacts/agent-demo-api/session-files.json) 的 6 组检查通过，使用受控 Bridge、零模型调用；[浏览器断网与终态滚动检查](../.test-artifacts/agent-demo-transport/report.json) 记录真实 Chromium 操作及受控 SSE。它们证明对应协议与布局场景，不能代替部署后的真实 Grok 长对话与延迟复验。

## 对话生命周期矩阵

表中“本地实现”只确认源码路径；组件隔离测试、服务端合同测试、整页测试与真实模型验证分别列在后文。

| 用户路径                                            | 上游入口                                                      | 方式                               | AutoOps 本地实现及边界                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录、选项目/环境、新建和切换会话                   | OC `createSession`；Hermes `newSession` / `loadSession`       | 已有能力                           | [App.jsx](../web/src/agent-demo/App.jsx) 保留登录、项目授权、私有/项目会话和运行模式；采用本项目上下文，未照搬上游本地工作区选择器。                                                                                                                                         |
| 找回会话、改名、删除                                | OC `patchSessionMetadata` / `deleteSession`；Hermes会话菜单   | 已有能力                           | 历史列表支持标题/正文筛选、重命名、删除、个人置顶与归档恢复。置顶/归档存储在(uid,cid)偏好中，HTTP和SSE均按接收用户投影，归档不停止执行；正文检索使用已授权快照，不是服务端索引。                                                                                             |
| 起草、切换后恢复、失败不丢输入                      | Hermes `send` / `_restoreComposerDraftAfterFailedSend`        | 已有能力 + 按流程改编              | [use-draft.js](../web/src/agent-demo/use-draft.js)、[Chat.jsx](../web/src/agent-demo/Chat.jsx) 按用户/会话保存草稿，发送回执确认后清除对应草稿，保留失败输入。                                                                                                               |
| 文件选择、拖入、粘贴和附件预览                      | OC `FileAttachment` / `ChatInput`；Hermes `send` 附件生命周期 | 已有能力 + 按流程改编              | Chat 附件入口、上传状态、[Content.jsx](../web/src/agent-demo/Content.jsx) 预览沿用本项目文件权限。文本及 PDF 文字层提取为可缓存内容，通过会话 ID 目录按需读取；图片保留原生视觉输入。扫描、加密、损坏等返回明确能力状态；Office 正文解析未实现。                             |
| 首次发送、重复点击、回执早晚交错                    | Hermes `send` / `attachLiveStream`                            | 已有能力 + 按流程改编              | 乐观用户消息以 `clientRequestId` 与服务端消息对齐；请求去重、失败保留草稿。服务端是轮次创建的唯一权威，界面不自行猜测已送达。                                                                                                                                                |
| 运行中继续输入，选择引导或排队                      | OC `ComposerActionButtons` / 键盘策略                         | 直接复制适配                       | [conversation-controls.jsx](../web/src/agent-demo/conversation-controls.jsx) 保留“有内容可跟进且可独立停止、空输入只停止”的状态分支；默认排队，偏好按用户保存。附带文件或运行器不支持引导时明确回退排队。                                                                    |
| 中文输入法、Enter、修饰键、移动端输入               | OC `composer/keyboardPolicy.ts`                               | 直接复制适配                       | [keyboard-policy.js](../web/src/agent-demo/vendor/openchamber/keyboard-policy.js) 及 controls：中文组合输入与结束后的保护期不发送；桌面 Enter 执行所选操作，Ctrl/Cmd+Enter 使用另一操作；移动端 Enter 换行。                                                                 |
| 排队预览、编辑、调整顺序、移除、暂停/恢复、立即执行 | OC `QueuedMessagesStrip` / `useQueuedMessageAutoSend`         | 直接复制适配 UI + 按流程改编服务端 | 单条预览、多条可展开；队列仍由 [server.mjs](../agent-demo/server.mjs) 持久化和派发。立即执行在空闲时原子领取指定项，不绕过停止或澄清状态。                                                                                                                                   |
| 已接收到首段输出之间的等待                          | OC `StatusRow` / `liveActivity`；Hermes流状态                 | 按流程改编                         | 按上游工作状态显示真实阶段；删除原先基于静默秒数的等待推断、自加计时和长等待提醒。澄清由表单承载，连接异常由全局连接状态承载。                                                                                                                                               |
| 正文流式输出，中文、表格、未闭合代码块              | OC `useStreamingTextThrottle`；Hermes增量 Markdown 生命周期   | 直接复制适配                       | [use-streaming-text.js](../web/src/agent-demo/use-streaming-text.js)、[streaming-markdown.js](../web/src/agent-demo/streaming-markdown.js)：32ms 合并更新、上游完整块提交、终态立即刷新、仅解析已提交的追加后缀。保持已完成 DOM 和选区，不使用假打字。                       |
| 工具调用、引导、澄清和续文交替                      | OC turn projection；Hermes `attachLiveStream` 事件分流        | 按流程改编                         | [timeline.js](../web/src/agent-demo/timeline.js) 按事件顺序组成稳定分段；完整Activity按上游规则收束工具/思考/过程文字；用户补充与最终正文保留各自位置。                                                                                                                      |
| 查看模型公开返回的思考内容                          | OC `ReasoningPart`；Hermes reasoning 事件和 Thinking Card     | 直接复制适配 UI + 按公开协议接入   | [reasoning.jsx](../web/src/agent-demo/reasoning.jsx) 使用上游摘要预览、展开、显示开关和运行时自动展开选项；无自行增加的秒数或复制条。桥接区分 summary/text、优先摘要、同卡替换和完成回补；不混入正文，不把工具活动称为模型思考。仅展示实际返回字段，不保证 Grok/CPA 提供它。 |
| 读取 token 用量                                     | OC work-status；Hermes metering / usage                       | 按流程改编                         | [codex-bridge.mjs](../agent-demo/codex-bridge.mjs) 转发官方用量快照，服务端保存，UI 展示输入/输出；缺失字段不伪造为 0，不估算价格。                                                                                                                                          |
| 自动跟随、上翻阅读、返回最新、嵌套区滚动            | OC `followScroll` / `timelineScrollIntent`                    | 直接复制适配                       | [use-chat-scroll.js](../web/src/agent-demo/use-chat-scroll.js) 使用一条跟随动画，尊重滚轮、键盘、触摸与滚动条意图；上翻暂停、返回最新恢复，输入区变高不夺走阅读位置。                                                                                                        |
| 打开长会话、向上展开早期轮次                        | OC `windowTurns`；Hermes `_loadOlderMessages`                 | 直接复制适配索引 + 按流程改编      | [use-history-window.js](../web/src/agent-demo/use-history-window.js) 初始最近 30 个完整轮次，每次展开 30 轮；同轮引导/答案不拆开。保持原可见行位置，新消息不裁掉已展开历史，换会话重置。当前是前端显示窗口，服务端仍给完整快照。                                             |
| 搜索当前对话并定位                                  | OC `ChatSearchBar` / `chatSearchHighlight` / reasoning reveal | 直接复制适配高亮 + 按流程改编      | [conversation-search.jsx](../web/src/agent-demo/conversation-search.jsx) 搜索正文及启用显示的思考部分，前后跳转，CSS Highlight 不改写 Markdown DOM。隐藏历史通过 `revealRow` 展开后定位；这不是全项目全文索引。                                                              |
| Agent 提问，回答失败再试，随后继续                  | OC `FormDock`；Hermes `respondClarify`                        | 直接复制适配 + 按流程改编          | `ClarificationDock` 不抢主输入框焦点；回答草稿按问题保存，迟到回执只清除自己的问题，失败可重试。本轮为单个问题及选项/自由文本，不包含上游完整多步表单。                                                                                                                      |
| 停止输出，保留已生成内容                            | OC `abortCurrentOperation`；Hermes取消流程                    | 已有能力 + 按流程改编              | 独立停止按钮；HTTP 接受停止后显示 stopping，等运行器终态；迟到内容不继续追加，保留部分正文/思考，队列暂停。HTTP 成功不等于提供方内部计费立即停止。                                                                                                                           |
| 失败或停止后继续                                    | Hermes重连/部分结果恢复                                       | 已有能力                           | `/continue` 创建新轮，在可恢复且授权未变时沿用原生 thread；旧活动轮仍是中断状态，不宣称恢复同一个执行进程。                                                                                                                                                                  |
| 重新生成最新回复                                    | Hermes `regenerateResponse` / `startRegeneration`             | 按流程改编                         | `/retry` 绑定最新已终结轮次，使用原输入/授权附件；保留旧回复，新模型上下文不包含被重试回复。并发或旧版本请求明确拒绝。                                                                                                                                                       |
| 从历史位置分支、编辑并重发                          | OC `forkAfterMessage` / `forkFromMessage`                     | 按流程改编                         | `/branch` 创建独立私有会话，按用户输入或助手回复边界裁剪；编辑在分支发送，原历史保留。处理中引导与澄清答案也按准确边界截取，附件/报告复制仍检查权限。                                                                                                                        |
| 复制回复、代码、导出对话                            | OC `exportSession`；Hermes代码复制/会话导出                   | 直接复制适配导出 + 已有复制        | [conversation-export.js](../web/src/agent-demo/conversation-export.js) 导出有序 Markdown、文件名和用户可见工具概况；思考随显示偏好包含。代码复制使用完整内容；不导出密钥、运行器配置或原始工具日志。HTML/JSON 导入导出不在本轮。                                             |
| 刷新、网络断线、SSE 缺口、服务重启                  | Hermes `attachLiveStream` / 会话恢复                          | 已有能力 + 按流程改编              | [use-demo.js](../web/src/agent-demo/use-demo.js) 游标重连、去重和快照修复；紧凑文本/思考增量含 offset，缺口不盲目拼接。主服务重启保存历史并标记活动轮中断；运行器内存重放不等于跨进程执行恢复。                                                                              |

## 未直接搬入的功能与剩余边界

| 分类             | 内容                                                                               | 原因或后续处理                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 不适用本轮       | 外部 Agent、子 Agent 编排、后台子任务回传                                          | 用户已明确第一轮不做外部 Agent；不能仅搬卡片而承诺调度能力。                                                                              |
| 不适用本轮       | OpenCode runtime/store、工作树、终端、代码差异审批；Hermes本机配置、记忆、技能控制 | 依赖不同运行器和权限模型；AutoOps 现阶段通过既定白名单业务工具执行。                                                                      |
| 不适用本轮       | 语音、TTS、定时任务、浏览器通知、公开分享链接                                      | 是独立产品能力，需要自己的权限、后台生命周期和验收，不属于本轮流式对话补齐。                                                              |
| 通用交互待补     | JSON 导入/导出、会话标签                                                           | 上游具有，本项目当前未覆盖。当前个人置顶/归档、列表正文检索、会话内搜索和 Markdown 导出不能替代这些独立数据交换或标签能力。               |
| 大型历史待补     | 服务端分页、增量历史查询、单个超长工具轮次的内部窗口、索引搜索                     | 本轮完整轮次窗口减少首次 DOM 数量，但快照传输、内存、搜索与全量投影仍随历史增长；主动展开后不回收旧 DOM。不能称为无限历史虚拟化。         |
| 文件能力边界     | 图片实际由 Grok/CPA 识别、扫描件 OCR、Office、多媒体                               | PDF 文字层已接入 PDF.js 并有受控验证，真实模型读取以本次部署后验收为准；扫描件 OCR 和 Office 正文未实现。预览／下载成功不代表模型已读取。 |
| 运行器恢复边界   | Bridge 或 CLI 重启后的上下文延续与原执行恢复                                       | 原生 thread 映射与 resume 已接入；恢复失败明确报错，不静默重置。活动执行仍会中断，继续是新一轮；跨进程恢复效果以对应受控和真实证据为准。  |
| 体验仍需实际验收 | 长时间对话、实体手机软键盘、慢网络与用户主观顺滑度                                 | 组件测试只证明它覆盖的交互条件；合成事件不能证明真实提供方持续输出节奏。                                                                  |

## 已取得的分层证据

| 层次                 | 证据                                                                                                          | 可得结论                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 增量 Markdown        | [6 组隔离浏览器检查](../.test-artifacts/prototype-v2/agent-demo-streaming-markdown/report.json)               | 已完成段落、代码和表格节点稳定；中文与未完成围栏可读；完成立即刷新、安全链接和代码复制可用。零模型调用。                                 |
| 输入、队列、澄清组件 | [10 组 Chromium 检查](../.test-artifacts/agent-demo-controls/report.json)                                     | 偏好、IME、移动端按键、停止可用性、队列回调和问题草稿隔离；不是整页后端接入的证明。                                                      |
| 历史显示窗口         | [7 组 Chromium 检查](../.test-artifacts/agent-demo-history-window/report.json)                                | 90 轮夹具完整分窗，展开后锚点误差不超过 1px；新事件、批量搜索、会话切换、空历史/短快照通过。使用实际跟随滚动 hook，零后端/模型调用。     |
| Reasoning / 用量协议 | [Bridge 受控检查](../.test-artifacts/agent-demo-api/codex-reasoning.json)                                     | 增量/完整回补、摘要优先、无重复、停止及失败终态；6 个受控运行、9 项检查，无 CLI 进程和模型调用。                                         |
| 新动作与持久化       | [服务端合同检查](../.test-artifacts/agent-demo-api/conversation-actions.json)                                 | 紧凑增量、用量、重启历史、分支边界、ACL、附件和幂等、重试、队列立即执行；以报告中的实际检查项为准，零真实模型。                          |
| 上一轮整页 UI        | [受控整页检查](../.test-artifacts/prototype-v2/agent-demo-chat-ux/report.json)                                | 等待反馈、事件顺序、滚动阅读、停止/刷新和移动端布局。本轮已复跑输入/队列整合；搜索、思考、分支的新增整页证据另见下方。                   |
| 上一轮真实模型       | [真实 Grok 网页流程](../.test-artifacts/agent-demo-chat-migration/live-web-before-full-migration/report.json) | 真实读取资料、提问、同轮引导、回答后继续、队列和停止；结束于 UTC 2026-10-21 01:23:19。本轮新增能力须由新增证据验证，不能套用此通过结果。 |

历史窗口首轮针对短快照替换的检查曾失败：可用轮次变少时仍保留旧起点，未补足默认显示窗口；已修正并复验，失败记录保留为 [shorter-snapshot-before-fix.json](../.test-artifacts/agent-demo-history-window/shorter-snapshot-before-fix.json)。本轮整页集成与部署后验收继续登记在 [验收记录](agent-demo-validation.md)。

## 本轮新增整页证据

- [11组完整页面流程](../.test-artifacts/prototype-v2/agent-demo-full-flow/report.json)：思考替换和折叠、正文分离、用量、搜索高亮、导出文件内容、偏好刷新、编辑分支、重新生成、回答分支、37轮历史与隐藏思考搜索、个人置顶归档/正文检索、390px布局。真实HTTP/SSE、受控Bridge，零真实模型。
- [缺口恢复6组浏览器检查](../.test-artifacts/agent-demo-gap-recovery/report.json)：丢片段后不让usage/reasoning推进脏状态，延迟/陈旧/失败快照，退避、删除和卸载清理。
- [个人会话偏好5组服务端检查](../.test-artifacts/agent-demo-api/conversation-preferences.json)：双用户HTTP/SSE及回放隔离、ACL/CSRF、幂等、运行中归档、重启和删除清理。

## 主要上游源码入口

下列链接均固定到本次读取的提交；表内函数名可在对应文件直接定位。

- OpenChamber：[ChatContainer](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/ChatContainer.tsx)、[ChatInput](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/ChatInput.tsx)、[会话与分支动作](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/sync/session-actions.ts)。
- OpenChamber：[流式节流](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/hooks/useStreamingTextThrottle.ts)、[滚动辅助函数](https://github.com/openchamber/openchamber/tree/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/lib/scroll)、[完整轮次索引](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/lib/turns/windowTurns.ts)。
- OpenChamber：[发送/停止控件](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/composer/ui/ComposerActionButtons.tsx)、[排队条](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/QueuedMessagesStrip.tsx)、[提问表单](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/FormDock.tsx)。
- OpenChamber：[ReasoningPart](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/message/parts/ReasoningPart.tsx)、[搜索组件与高亮](https://github.com/openchamber/openchamber/tree/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/search)、[Markdown 导出](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/exportSession.ts)。
- Hermes：[messages.js](https://github.com/nesquena/hermes-webui/blob/3aa21f63387939dcff37baa141ad59a0e1e1147f/static/messages.js) 的 `send`、`startRegeneration`、`attachLiveStream`、增量 Markdown、`respondClarify`；[sessions.js](https://github.com/nesquena/hermes-webui/blob/3aa21f63387939dcff37baa141ad59a0e1e1147f/static/sessions.js) 的 `newSession`、`loadSession`、`_loadOlderMessages`、归档/导出/删除；[ui.js](https://github.com/nesquena/hermes-webui/blob/3aa21f63387939dcff37baa141ad59a0e1e1147f/static/ui.js) 的 `regenerateResponse` 和 Thinking Card。
- 会话与恢复：OpenChamber [client.ts 的 sendMessage / compactSession](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/opencode/client.ts)、[health-wait.js](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/opencode/health-wait.js)。
- 文件与能力：Hermes [upload.py](https://github.com/nesquena/hermes-webui/blob/3aa21f63387939dcff37baa141ad59a0e1e1147f/api/upload.py)、[streaming.py 的 _build_native_multimodal_message](https://github.com/nesquena/hermes-webui/blob/3aa21f63387939dcff37baa141ad59a0e1e1147f/api/streaming.py)；OpenChamber [attachment-files.ts](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/sync/attachment-files.ts)；Mozilla [PDF.js Node 示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)与[API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)。PDF.js 使用锁定的 npm 包 `6.4.299`，Apache-2.0；示例链接用于核对 API，不将浮动 master 当成本地依赖版本。
- 阅读位置：OpenChamber [useChatTimelineScroll.ts](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/hooks/useChatTimelineScroll.ts)、[messageViewportAnchor.ts](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/lib/scroll/messageViewportAnchor.ts)、[holdAnchor.ts](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/lib/scroll/holdAnchor.ts)。

## 消息分支入口：上游原因、适配边界与处理（2026-10-21）

本次以 OpenChamber 固定提交 `6491f51dbcf05d1e3f7f823049f5f097c96c234b` 为消息操作层级的单一基准。Hermes 的直接分支入口不再混入助手操作。以下“好用的原因”是基于源码的设计分析；浏览器检查验证操作是否正确，不代表已经证明用户的主观体验。

| 上游规则及来源                                                                       | 作用                                                     | AutoOps 的不适配处                                                                  | 已采用的处理                                                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面使用悬停图标；助手图标区支持 `focus-within`。`MessageBody.tsx:561–590,2283–2287` | 阅读时不反复出现同一组文字操作；键盘用户仍能到达按钮     | 本地曾把图标和文字常驻在所有消息下；按钮区域在菜单 Portal 打开后可能失去 hover      | 复用图标行与 Tooltip，保留占位防止布局跳动；用户和助手均支持 focus，菜单打开期间保持入口可见                                                     |
| 用户图标直接 fork；助手 branch 图标先开菜单。`:664–682,2021–2060`                    | 从回答分支是一项明确选择，打开菜单本身不新增会话         | 旧助手按钮直接调用 `/branch`，容易误认为“展开分支”却实际复制历史                    | 助手先打开菜单，选择“从这里分支”才发请求；继续使用原有请求锁、幂等键及版本检查                                                                   |
| 助手 footer 只在本轮最后消息、有正文、结束或报错时显示。`:1597`                      | 一个最终回答对应一个操作位置；工具和思考不是独立对话分界 | AutoOps 的同一轮可被引导／澄清拆成多个 UI 片段，但这些片段共用一个后端助手 ID       | 仅最后片段、终态、有正文显示 footer；前面的过程片段和空占位不显示分支；停止后保留部分正文可操作，空错误单独保留重试                              |
| 触屏只有“更多”，面板内是带文字、至少 44px 的操作行。`:591–639,2266–2332`             | 触屏无需 hover，也不用在一排小图标中猜测含义             | 上游 `MobileOverlayPanel` 依赖其移动返回层、键盘和 UI stores；本地已经使用 Radix    | 保留同一操作流程，以现有 shadcn Sheet 承担 Portal、焦点陷阱、Escape、遮罩关闭；检测屏宽和 pointer/hover，不漏掉宽屏触控设备；编辑弹窗接管焦点    |
| `session-actions.ts:2739–2755,2829–2872` 按消息边界 fork                             | 可以在保留原会话的情况下尝试另一条路径                   | 上游由 OpenCode SDK 截断历史；本地需要裁剪持久化 turn、工具和附件，并且支持同轮引导 | 普通用户分支保留此前历史，并将选中输入／附件放入新草稿；助手分支保留该轮，均不自动运行；特殊引导／澄清边界必须使用当时快照，不能复制整轮最终状态 |

实现入口：[消息操作组件](../web/src/agent-demo/message-actions.jsx)、[样式](../web/src/agent-demo/message-actions.css)、[消息显示条件](../web/src/agent-demo/Chat.jsx)、[服务端分支协议](../agent-demo/server.mjs)。这是源交互规则的适配；没有把 OpenChamber 的整个 OpenCode store 搬进另一套运行器。

未迁入菜单的“新建多模型运行”“询问其他模型”等依赖项，原因是第一轮范围与后端能力不支持，不能仅复制按钮形成不可兑现的操作。“编辑并重发”继续明确创建分支并发送，不假称能够撤销项目文件或回退运行器状态。

分支仍然会产生独立会话，这是上游功能本身。在最后一条回答处分支，会保留到该回答为止的全部历史，所以内容看起来相同；它不是只展开一段 UI，也不是复制一份项目环境。

上游：[MessageBody.tsx](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/chat/message/MessageBody.tsx)、[session-actions.ts](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/sync/session-actions.ts)、[MobileOverlayPanel.tsx](https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/components/ui/MobileOverlayPanel.tsx)。MIT 归属已更新至随构建发布的 notices。

分支协议仍有两个明确限制与处理方式：

- **活动会话的历史分支**：上游可以在原会话继续执行时分出旧历史；本地目前要求源会话空闲。现阶段对菜单触发器和选项同时禁用，并由服务端再次校验，不呈现能执行的假入口。若后续开放，需要以不可变的已结束轮次快照创建新会话，并重新验证版本冲突、附件授权及后台并发，不能只删除禁用条件。
- **运行器内部状态**：当前分支复制授权的历史与附件，新一轮根据用户／助手正文和问题记录建立运行器输入。它不克隆运行器的内部缓存、完整工具上下文或项目文件。当前方案适用于“保留可见历史，尝试另一条对话路径”；若要求原生运行器 fork，必须增加该运行器的检查点恢复适配与权限/文件映射，再验收跨轮工具上下文。UI 换成上游按钮不能补齐这项后端语义。

特殊边界修复使用持久化的 `conversation.updated` 接收快照，按会话、时间及事件序号查询；引导／澄清后的工具结果和追加思考不会回灌到此前历史。未完成工具标记取消，部分轮次标记中断。旧导入记录没有精确快照时返回 `BRANCH_BOUNDARY_UNAVAILABLE`，原会话及草稿保持不变；用户可改从普通用户消息或已结束助手回复创建分支。该边界表示主服务确认接收输入，不等同于证明模型已应用引导。
