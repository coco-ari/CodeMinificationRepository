# T3 完整对话模块覆盖与证据

产品范围补充：下表保留完整模块迁入时的源码与验收记录；当前 Demo 按 [项目助手精简版](agent-demo-lite-profile.md) 开放功能。源码保留不等于默认启用；计划、分支、回退、子任务等旧证据不能作为精简版仍开放新增操作的说明。

状态：实施验收记录，**不是所有场景均已通过的声明**。核查日期：2026-10-21。固定来源为 T3 Code `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`；范围为[批准的迁移方案](agent-demo-t3-migration-plan.md)中的 43 项及 D01–D13。本文分别标注源码接线、确定性回归、真实模型与真实浏览器证据，不以文件复制量或单测数量推定完整体验。最终 v9 core/static6 的 Plan 新会话来源与业务范围真实复验、30 次队列反馈和真实进程崩溃恢复已通过；正式 8787 已切换 release stage10（core9/static6），固定导入的 9 份历史、旧文件、草稿及桌面/窄屏只读验收完成。

## 证据与路径约定

`W/` = `vendor/t3code/apps/web/src/`，`B/` = `vendor/t3code/apps/server/src/`，`C/` = `vendor/t3code/packages/client-runtime/src/`，`A/` = `agent-demo/t3-adapters/`。S01–S21 固定提交源码链接见迁移方案附录；本地同路径为导入和适配后的实际实现。

U 表示单元、故障注入或协议回放；B 表示真实浏览器（组件浏览器与部署页面分别注明）；N 表示真实 Codex 元数据/协议；M 表示真实 CPA/Grok 执行。下表的“未覆盖范围”不表示另造简化实现：原生链路已保留，但不能把没有收到过的事件或没有操作过的设备写成实测通过。

| 证据代号 | 类型及具体范围 | 记录 |
| --- | --- | --- |
| U1 | 原生输入、Markdown、问题组：6 文件、148 个浏览器组件用例通过 | `.test-artifacts/t3-final/input-markdown-browser-tests.log` |
| U2 | 恢复、重放、分页、Intake：9 文件、98 个用例通过 | `.test-artifacts/t3-final/recovery-stream-tests.log` |
| U3 | Scheduler/runtimeLayer 额度恢复等：2 文件、104 个确定性用例通过 | `.test-artifacts/t3-final/limit-recovery-tests.log` |
| U4 | 原生路径、配对恢复、计划保存、CSP、worker policy：9 个回归通过 | `.test-artifacts/t3-final/adapter-regressions.log` |
| N1 | catalog/skills/subagent/worker policy 8 项，provider 与实际 Codex 0.159.2 元数据 13 项通过；元数据测试没有 turn/start | `test/t3-native-catalog.test.mjs`、`test/t3-subagents.test.mjs`、`test/t3-worker-policy.test.mjs`；`B/autoops/nativePolicy.metadata.test.ts`、`B/provider/CodexProvider.test.ts`；`/private/tmp/t3-native-policy-{tests,provider-tests}.log` |
| M1 | 100 个真实完成轮次，错误列表为空；保留此前失败报告 | `.test-artifacts/t3-live/soak-4.json` |
| M2 | 真引导、队列编辑/排序/取消/转引导，断开重连、回执去重、停止和继续，两项通过；这是 RPC 与真实运行器证据 | `.test-artifacts/t3-live/controls-v7.json` |
| M3 | 真实 ask_user 的选项回答、拒答、停止后迟到回答拒绝，三项通过；多字段由协议回放补充 | `.test-artifacts/t3-live/questions-v8.json` |
| M4 | 原生保护 fork、共享回退、重复回执、回退后真实记忆续接 | `.test-artifacts/t3-live/rollback-v7.json` |
| M5 | 注册技能正文实际加载，真实业务工具；原生子任务、固定模型、ACL、父停止后的后代中断 | `.test-artifacts/t3-live/native-capabilities-followup.json` |
| M7 | 实际执行进程 SIGKILL 后自动重启，问题/执行终结、迟答拒绝、队列保持 hold、5 秒无新增 provider turn 或重复消息、原 native 身份保留，正 cursor 补流 | `.test-artifacts/t3-live/restart-stage9-reconciled.json`；保留首次 `restart-stage9.json` 失败 |
| M6 | 真实 native compact 完成，随后一轮恢复压缩前记忆；同报告其他失败项不由此变成通过 | `.test-artifacts/t3-live/business-v4.json` **compact 项** |
| B1 | 部署页面基础交互 12 项通过：中文多行草稿切换/刷新、Stash、文本历史、选文引用/复制、改名、pin、settle、snooze、未读、归档恢复、个人流式偏好及另一账号隔离；复用既有一轮，新增模型请求 0 | `.test-artifacts/t3-live/basic-ui-stage8-complete/report.json` |
| B2 | 18,481 字真实输出、wheel 上滚后不抢位置、回到底部、终态刷新保持原生身份 | `.test-artifacts/t3-live/browser-static-v3-flow/report.json` |
| B3 | 浏览器真实 WebSocket close 后连接数 1→2，无新增 native run；同一发送帧被两个观察器计数不能当成两次发送 | `.test-artifacts/t3-live/browser-static-v3-ws-reconnect/report.json` |
| B4 | 60 轮真实历史的 3 页分页与搜索；另 1000 合成轮/2000 消息/16.38 MB 工具正文，3 次 prepend 锚偏移 <1 px、8–12 消息 DOM、最早轮定位，模型调用 0 | `.test-artifacts/t3-live/browser-stage7-history-counted/report.json`；`.test-artifacts/t3-history-1000-20261021-v2/scale-browser-v4/report.json` |
| B5 | 原生资料/目录引用、标签预览、技能 picker；设置中启用上游默认关闭的 Plan 功能后出现 /plan、/default，固定模型环境无 /model | `.test-artifacts/t3-live/browser-static-v4-native-command-settings/report.json` |
| B6 | 共享 Edit from here 的真实确认、保护分支、回退完成、编辑器恢复 | `.test-artifacts/t3-live/browser-stage7-shared-edit/report.json` |
| B7 | 30 次真实 Queue 提交与持久化回执、随后取消；单调时钟：浏览器 click→DOM 本地反馈 p95 13.7 ms，Node WS send→Exit Success p95 74.971 ms。一个真实 Plan 执行完成加 30 份取消队列，不是 30 轮模型完成 | `.test-artifacts/t3-live/browser-stage9-static6-monotonic-final/report.json` 的 planFeedback；早期 stage8 Date.now 报告保留，不作为最终计时依据 |
| B8 | 两页面脏队列编辑冲突，原草稿保留，修改及附件进入原生 Stash；附件原件补读 200/30 B | `.test-artifacts/t3-live/browser-stage8-queue-plan/report.json` **第一项**；同报告 Plan 项失败未抹去 |
| F1 | 真实 PDF 生成、中文文本及私有隔离；真实 HTML iframe 按钮 0→1、CSP、其他成员签名资源 404 | `.test-artifacts/t3-live/pdf-v4-followup.json`、`html-v4-followup.json` |
| F2 | 实际 Chrome 原生面板：新中文 PDF 一页、旧 PDF 两页可见并可保存；Office 沿上游显示不支持预览及下载，不能写成 DOCX 页面渲染 | `.test-artifacts/t3-live/document-ui-stage8/report.json`、`legacy-document-ui-stage8-followup/report.json` 及对应截图 |
| F3 | 3 份旧文件实际旧链接→授权映射→200，字节与原始文件完全一致 | `.test-artifacts/t3-live/legacy-files-stage7/report.json` |
| P1 | 真实 Plan 与授权业务保存、下载；部署页面 Save 2372 B 通过 | `.test-artifacts/t3-live/plan-v7.json`；`browser-static-v4-reference-plan-save/report.json` 的保存项 |
| P2 | 真实 Implement 创建新会话，唯一 launch 的 wire.sourcePlanRef 与最终 run.sourcePlanRef 相同，源 plan completed，业务 scope 继承且 private；项目菜单无“无项目”/任意路径入口，2 项通过、0 pageerrors | `.test-artifacts/t3-live/browser-stage9-static6-monotonic-final/report.json` |
| B9 | 正式入口只读复核：9 份历史/8 readonly+1 verified；4 活动只读提示，另外 4 readonly 原已归档且实际 Archive 列表可见；1 Stash 刷新保持、3 旧文件字节不变、代码高亮、390 px 无横溢；0 模型请求，原消息/run/providerTurn 计数不变 | `.test-artifacts/t3-live/production-readonly-release10-summary.json`，保留原报告和独立跟进 |
| D1 | 正式离线导入与独立全量对账：9 会话、3 文件、7 草稿、6 个人偏好、1 verified/8 readonly；未启动 provider | `.test-artifacts/t3-a11-20261021/final-{snapshot-preparation,import-v8,cutover-verification}.json` |

M1 的 5 份原始 native rollout 另做只读词法扫描：104 条 assistant 消息中控制标记 0、相邻长重复块 0，见 `.test-artifacts/t3-live/soak-native-output-scan.json`。这是本次样本的词法结果，不证明模型语义正确，也不保证未来绝不重复输出。

## 43 项对照

| ID | 上游及实际调用链 | 适配与当前证据 | 明确未覆盖范围或验收边界 |
| --- | --- | --- | --- |
| I01 | S01/S02；`W/components/chat/ChatComposer.tsx` → `ComposerPromptEditorTiptap.tsx` | 原生 Tiptap/序列化，T3Host 加载原生 AppRoot；U1、B1 中文多行草稿与选区操作 | `fill()` 不等于系统中文 IME；实体设备组合输入、软键盘未验 |
| I02 | S03；`composerAttachmentFiles.ts`、`composerDraftUploads.ts` → `B/orchestration-v2/ThreadMessageIntake.ts` | `B/autoops/http.ts`/`A/access.mjs` 附件授权；Office/PDF 真实提取 8U，F1/F2；B8 文件随冲突草稿保留 | 图片理解、实体手机拖放、所有网络上传失败组合未做真实 M/B 穷尽 |
| I03 | S03；原生 mention → `W/autoops/resources.ts` → `B/autoops/resources.ts`/`A/resources.mjs` | 资料/目录身份映射；原生 FileBrowserPanel 与 AttachmentFilePreview；B5、F2/F3 | 不把业务资源转换成任意主机路径；跨成员授权由服务端测试及真实私有资源 404 覆盖 |
| I04 | S04；`AssistantSelectionToolbar.tsx`、引用序列化 → `A/rpc-policy.mjs`/`access.requireReference` | B1 真实选文引用/复制；受众检查阻止私有引用转共享泄漏 | 跨会话引用后的所有权限变更/跳转组合未做完整部署页面矩阵 |
| I05 | S01/S02；`ComposerCommandMenu.tsx` → `B/provider/CodexProvider.ts` → native skills/list | `A/skills.mjs` 注册真实 SKILL.md；空目录真实 []；N1、M5、B5。命令跟随原生设置：compact 与开启后的 plan/default | 不是插件安装器；仅管理员注册技能。不能把 Plan 默认关闭误判成入口缺失 |
| I06 | S04；`ProviderModelPicker.tsx`、`TraitsPicker.tsx`、`runtimeModeConfig.ts` | fixed catalog/三种 native role 固定模型，probe/runtime 初始化后有效配置检查；N1/M5；B5 Plan 入口 | 固定 Grok 与业务权限不允许 UI 切任意模型；P2 已验证 Plan 新会话来源/范围，未开放任意 provider |
| I07 | S05；`composerDraftStore.ts`、`promptStashStore.ts`、`composerPromptHistory.ts` | 用户命名空间、legacyDrafts；B1 草稿/历史/暂存，B8 竞态保留，迁入 7 行取得当前账号 1 份非空 Stash 并刷新保持 | Prompt history 按上游仅文本；容量/失败分支有 U，非所有实体设备离线状态已实测 |
| I08 | S06；`ComposerPrimaryActions.tsx`、typing guard | 原生键盘与折叠输入；U1、B1 快捷键、B7 连续提交反馈 | 真手机软键盘、组合态输入后发送仍未验；不得用桌面 viewport 代替真机 |
| I09 | S20/S21；`ContextWindowMeter.tsx`、ChatView compact → Codex thread/compact/start | 原生 token/压缩通路；M6 真 compact 完成后记忆恢复；`B/autoops/usage.ts` 仅聚合可见 native thread；CPA 未报容量保持 null | 压缩通过不能推定额度恢复；不伪造 context/cost/reset；额度见 X06 |
| E01 | S06/S15；`C/state/composerDispatch.ts` → ThreadCommandExecutor/CommandReceiptStore | 单 commandId/outbox；M1/M2 去重和回执；B7 30 次连续本地反馈/持久化回执 | 丢回执由 U2/回放覆盖；30 Queue 不等于 30 个模型完成轮次 |
| E02 | S06/S07；threadWorkflows → native steer | 实际默认 Queue、显式 steer；M2 真实当前执行引导通过 | 不能把源码某默认值写成当前全局默认；压缩/终态边界用原生状态守卫 |
| E03 | S07；QueuedRunsControl/useQueuedRunEdit → queued-run 命令 | M2 编辑/排序/取消，B7 连续提交，B8 两页面冲突及附件保存通过 | 共享队列仍为共同事实；不覆盖另一页面原草稿 |
| E04 | S07/S15/S17；queued-message.promote-to-steer 原生命令/outbox | M2 真实提升、队列占位移除及运行内容确认；沿原生命令回执消耗 | 非自建“删队列后再发送”；未把所有未知网络结果组合称为部署 M 已过 |
| E05 | S06/S19；interrupt/hold queue → native 终态 | M2 真 running 后停止、3 秒无后续增长、继续保留记忆；M5 父停止后代中断 | Codex 父停止证据不等于上游仅 Claude workflow 的 Stop entire workflow 按钮 |
| E06 | S14/S19；ProviderStatusBanner、恢复服务 | 原生错误类型/可恢复性；U2、M2 停止后继续、B3 重连 | CPA 真额度重置未知；不把会话文本重放冒充 native 续接 |
| E07 | S02/S21；draft background send/send-and-new-thread | 保留完整 ChatView/dispatch 编排；host 新建先绑定范围，U1/U2 覆盖相关底层 | 后台发送失败同时继续编辑的全部部署 B 组合未单列实测；实现接线与实测分开 |
| T01 | S08/S15；MessagesTimeline ← native projection | 唯一时间线/工作组/尝试分组；M1、B2、B4，终态刷新一致 | 合成长历史用于布局规模，不是 1000 轮真实模型 |
| T02 | S08/S09/S17；WorkLog/CodexToolPresentation | M5、F1 真实多工具与公开 reasoning 摘要；U1 原生展示 | 没有模型公开摘要时不补写“思考”；不展示或虚构隐藏思维链 |
| T03 | S09；ChatMarkdown、markdown-incremental、syntaxHighlighting | U1；B2 长正文；官方 Shiki JS regex engine 用于严格 CSP host，4 语言实际组件浏览器通过，原生主题/grammar/缓存管线保留 | 不放宽为 unsafe-eval/wasm-unsafe-eval；B9 部署历史实际渲染 5 块/77 个彩色 span，CSP/WASM 错误 0；JS regex 病态输入性能不由这些样本保证 |
| T04 | S08/S14；responseStreamingMode/活动状态 | 实际默认 paragraph；B1 个人偏好修改/刷新/另一账号不变，B2 真流式、B7 等待反馈 | 首 token 受模型/工具/上下文影响，不能以整轮快慢单归因 UI |
| T05 | S09；LegendList + timelineScrollAnchoring | B2 真 wheel/自由阅读/回底；B4 3 次 prepend <1 px。初次空 draft 变 native thread 时重挂原生 scroll node 监听已修 | 没引入第二套滚动算法；实体手机软键盘改变 viewport 未验 |
| T06 | S10/S18；useThreadFindNavigation + threadHistoryPaging/HTTP | B4 60 真实轮与 1000 合成轮分页、搜索、定位；HTTP/WS 同一 ACL | 搜索不依赖已挂载 DOM；跨会话引用组合见 I04 |
| T07 | S08/S17；工具详情 → business-tools/resources/ResourceLink | F1 真实产物；F2 新旧 PDF 可见及下载、Office 下载；F3 旧链接字节精确；ACL 私有访问 404 | Office 不支持原生页面预览时沿上游明确空态；不伪装 Office 渲染 |
| T08 | S04/S14；ProposedPlanCard/TasksBadge/压缩项 | P1 真 Plan/保存下载，P2 真 Implement 新会话来源、范围和 completed；原生菜单/对话框只映射授权资料 | v8 丢 sourcePlanRef 的失败保留；RPC mapper 修复经 103U/类型及 v9 真复验通过；不开放任意 filesystem write |
| T09 | S13；ProviderSubagentBar/lineage → CodexAdapterV2.registerSubagentThread | 真实 provider 事件建父子关系；N1/M5 固定模型、原生 spawn/wait、父权限继承、子只读、跨成员拒绝、父停止均通过 | 无外部 Agent 注册；子状态读 providerTurns/nodes，不能误要求其 runs 非空；完整父子移动导航未单列 B |
| T10 | S08；HtmlRenderFrame/McpAppFrame → htmlRender/mcpApps | F1 真实原生 HTML iframe 交互/CSP/私有授权；MCP App 完整 host 与动作授权接线保留 | 当前无业务 MCP App resource 注册，故真实 App tool/context/navigation 尚无事件可验 |
| R01 | S11/S16；PendingUserInputPanel → Intake → Codex elicitation | M3 真实选项回答；U1 问题组，16U/2 原生回放；固定 Effect 4.0.5 patch 修旧 MCP 协议选项映射 | 当前业务 ask_user 是单字段；多字段由协议与组件测试覆盖，不宣称真实多字段 M 已过 |
| R02 | S11/S19；pending request state/response command | M3 拒答、pending 时停止、迟到回答拒绝；U2 requestId 与生命周期 | 两个真人同瞬间抢答、所有网络故障组合未穷尽；重复提交沿原生命令幂等 |
| R03 | S12/S17；PendingApprovalPanel/Actions → policy | 原生组件保留；shell/fs/network 拒绝；F1/P1 已授权报告/计划保存是真实写工具且用明确白名单审批 | 当前业务白名单自动授权，不人为制造一条假审批；未知写入不能借 readOnly 注解放行 |
| R04 | S12；SecretRequestCard/原生请求 | 保留原生代码与协议能力，当前没有注册业务凭据请求数据源 | 未实现可用的业务收密钥流程，不引导用户在共享消息中填 key；开放前必须补私有提交/日志隔离验收 |
| H01 | S08/S10；消息动作/SelectionToolbar | B1 真实选择、引用、复制；B6 编辑；未保留旧重复分支/完成气泡 | 实体手机无 hover 的全部动作发现性未验 |
| H02 | S10/S13/S17；thread/fork/lineage/business forkBinding | M4 真保护 fork；来源/附件/受众授权，默认私有；迁入 dynamicTools 白名单转发与可信 fork lineage 已接线 | 保护 fork 不替代所有用户手动分支路径；迁入历史分支后续接需独立真实样本才可称 M 通过 |
| H03 | S08/S10；Edit from here → rollbackSafety | M4 真回退与重复回执、B6 共享确认/编辑器恢复；原生备份和 revision 冲突保护 | 故障写盘/结果不明冻结由注入 U 覆盖；外部报告不会随会话回退而撤回 |
| H04 | S06/S10/S17；失败恢复/后续 run | U2、M2 真实 stop/continue，M4 回退后继续；只读旧历史有明确能力门禁 | Retry、Continue、Edit 保留不同原生语义；8 份无可信 native 绑定旧历史不谎称可续接 |
| H05 | S10/S13；useThreadActions/thread menu | B1 改名、个人归档/原生设置页恢复，另一账号不变；删除后 ACL tombstone 接线 | 删除/生成标题等并非本轮 B1 全部逐按钮实测，不能由菜单可见推定成功 |
| H06 | S13；pin/reorder/settle/snooze → preferences/personalPreferences | B1 pin 刷新、settle/wake、snooze/wake、未读与另一账号隔离；实际 Effect DateTime 连续写入 bug 修复，11U | 自动到期 sweep/排序等有确定性路径，未宣称所有长期定时状态经真人数日观察 |
| H07 | S10/S13；Sidebar/ThreadScopeControl/useThreadScope | 项目/环境/Agent 绑定；B5 引用；P2 最终静态6新会话项目子菜单门禁真复验通过 | Git/终端/IDE 任意路径不属于业务范围；无项目和路径穿透必须服务端同时拒绝 |
| X01 | S15/S18；native bootstrap/stream/replay/projection | 同源 gateway 全链授权；U2、M2 实际重连回放去重、B3 浏览器 WS close 重连 | 明确是真实连接关闭，不泛化为物理断网超时；未自建 SSE 消息协议 |
| X02 | S19；ProviderRuntimeRecoveryService | U2 原生 run/request/queue 恢复；A07/M7 真实 SIGKILL 重启后 run/request 终结、迟答拒绝、queue 保持 hold、5 秒无重复、正 cursor 补流通过；A11/D1 配对保全与无 outbox 导入 | 首次命令异常与实际进程重启分别记录；不称所有崩溃时序均已实测；迁入 queue hold，绝不自动重放 |
| X03 | S01/S06/S08；原生布局 + UI Radix facades | 按 [T3 UI 规范](t3-ui-standard.md) 使用原主题与中文界面，已撤旧 Solid Glass 覆盖；原有组件浏览器、部署页 B1/B2/B5/B8 证据保留 | 真 iPhone 当前已配对但 disconnected，尚未执行；软键盘/安全区/真机性能未验 |
| X04 | S14；server settings → settings-preferences/personalSettings | B1 流式偏好两账号隔离、刷新持久化；host 仅个人全局 scope；provider/global 设置不开放 | 通知送达/多台实体设备全部偏好组合不是 B1 已覆盖范围 |
| X05 | S03/S05/S14/S19；加载/错误/空态/权限 | 原生反馈；真实登录、readonly、资源无预览/签名拒绝；N1 配置污染失败关闭；U2/U3 恢复 | quota/expired file 等未发生的每种提供方事件不能靠静态卡片算 M 通过 |
| X06 | S14；UsageLimitRecoveryBanner/UsageLimitRecoveryWorker | U3 104 个 Scheduler/runtimeLayer 用例，含可信 reset 到期/取消/恢复守卫；按 actor 设置与原生 run | CPA 当前无可信 reset 时间，真实额度恢复 M 无证据；不估算或伪造重置，不自动越权恢复 |

## D01–D13 的接线审查

| 差异 | 实际入口与适配 | 当前证据与边界 |
| --- | --- | --- |
| D01 | B/autoops/projects、W/autoops/ThreadScopeControl、A/access | 业务项目/环境/Agent 取代代码仓库目录语义；新建子菜单无项目/绝对路径门禁已修。Git/worktree/终端不开放，不能保留绕过门禁的入口。 |
| D02 | A/resources、B/autoops/resources、W/autoops/ResourceLink | B5/F2/F3：原生资料/目录/附件显示与旧链接映射。授权身份贯穿 picker、预览、下载；不接受任意宿主路径。 |
| D03 | A/codex-policy、native-catalog、B/autoops/nativePolicy | N1/M5/F1：named permissions、root deny、network false、唯一模型及 MCP 白名单；报告写入仍标真实 write，未谎标 readOnly。 |
| D04 | ProposedPlanCard/Plan-Build + 业务 MCP/plan 保存端点 | P1 保存下载通过；P2 最终 v9 的 Implement wire/run 来源一致、源 plan 完成、范围继承通过；保留原 v8 失败。 |
| D05 | fixed provider/model + native subagent | M5：只接受真实 provider 父子链，子线程只读，固定模型与父授权继承；无外部 Agent 注册/工作流编辑器。 |
| D06 | W/components/ui/radix-compat 与完整 Toast/number/浮层；[统一 UI 规范](t3-ui-standard.md) | 当前撤旧 Solid Glass 覆盖、使用 T3 原主题并中文化；兼容层保留，未宣称全部恢复 Base UI。中文化相关定向测试 581 项（含 19 项控件浏览器测试），正式页面 7/7（`.test-artifacts/t3-ui-zh/production-final/report.json`）。原有 B/U 与 B1/B5/B8 证据保留，组件测试不替代物理触屏。 |
| D07 | B/autoops/rollbackSafety + ChatView 确认/冻结 | M4/B6：保护性 native fork、revision、重复命令一致；失败结果不明冻结由 U 注入，外部产物不回退。 |
| D08 | A/preferences/settings-preferences、B/autoops/personalPreferences/personalSettings | B1 两账号隔离/刷新通过；Effect 4 epochMilliseconds 修复及 11U；不广播个人整理事实，水位仍为 native sequence。 |
| D09 | business-documents(.worker)/business-tools，外置字体资源 | DOCX/XLSX/PPTX/中文 PDF 8U，真实 DOCX 模型读取、F1/F2。Office 不支持页面预览时保留上游空态/下载；资源和许可随发布。 |
| D10 | t3-import-data、B/autoops/legacyImport、t3-native-paths | D1：纯 EventSink 导入、无 provider/outbox；1 verified/8 readonly，全部数据独立对账；native rollout 索引重定位与 launcher fail-closed 经过 U4/A11。 |
| D11 | T3Host → 原生 main/AppRoot/router/stream | 新 run 唯一使用 T3 core；正式 stage10 已切换、旧 bridge disable/inactive；B9 正式历史/文件/草稿只读复验通过，原 run/消息计数不变。 |
| D12 | useQueuedRunEdit + 原生 Stash/草稿/上传 | B8 两页面真实冲突保存修改和附件，原草稿不被覆盖；B7 30 次队列反馈。不是另造第二套队列。 |
| D13 | McpAppRequests/HtmlRender + access/rpc-policy/usage | F1 HTML 原生可交互、逐次授权/私有拒绝；可见 thread 用量过滤；无业务 MCP App/Secret 数据源时不假造流程事件。 |

## 当前真实限制

1. **未有真实事件的能力**：手动 compact 已有 M6 证据，但 CPA 未给可信 reset，因此额度自动恢复仅有确定性 U；当前没有业务 Secret 请求或 MCP App resource 注册。原生组件/协议留存不等于已开放业务入口。
2. **设备与覆盖范围**：中文多行输入和桌面窄 viewport 已测，但没有物理 iPhone 软键盘/输入法/安全区实测。设备虽已配对但当前 disconnected，不把连接检查写成真机通过。通知送达、全部后台发送/权限瞬变组合亦未穷尽。
3. **原生技能和子任务**：额外宿主技能 disabled，注册技能取真实 SKILL.md 与 native skills/list 交集。有效 config 出现未注册 Agent role 即失败关闭，避免角色在 spawn 模型检查后覆盖固定模型。子线程 runs 可以为空，状态来自 providerTurns/nodes；Codex 父停止不等于为它新增 Claude 专用 workflow 按钮。
4. **模型与性能**：未知 context/cost 保持未知；UsageSummary 只聚合可见线程。100 轮稳定性、30 次队列反馈、1000 合成轮渲染各证明不同事情；系统提示、工具和后台标题不同，不能将整轮时延差全部归于 UI。词法扫描不能保证提供方今后永不发重复内容。
5. **旧数据和外部产物**：无可信 native 身份的旧历史只读；全量 SQLite 导入不等于全部可续跑。报告等外部产物不会随历史回退消失。没有无损反向迁移时保存新版完整数据和只读副本，不用旧 SQLite 覆盖新会话/文件/推进头。

## 修复与复验的证据边界

基础交互早期阶段暴露个人 pin/settle/snooze 失败：Effect 4 DateTime 使用 `epochMilliseconds`，覆盖层曾只识别 `epochMillis`。已改真实字段兼容，11 个 U 通过，B1 又完成实际部署连续操作、刷新和另一账号隔离。B1 是 12 项，不是 13 项；该次复验新增模型请求 0。早期 `basic-ui-stage7-v3` 的 kind 误写 no-model，实际有一轮模型，原记录保留，不把它当无模型测试。

PDF 早期报告只检查面板/下载而漏掉 PDF 被宿主 CSP 阻止，`document-ui-stage7-csp/clarification.json` 明确保留并纠正。现仅 T3 静态入口 object-src self，其余页及 artifact sandbox/CSP 不变，6 个实际 HTTP 响应回归与 F2 视觉复验均过。旧签名预览另修 `assets.createUrl` 当前 actor 注入，保留前置 ACL，新增 2 个身份/撤权回归和 64 个原资产/附件回归通过；F3 及旧 PDF 两页截图证明映射后字节/预览均在。

严格宿主 CSP 下 Shiki WASM 曾被阻止。放宽 wasm-unsafe-eval 的尝试被自动审批拒绝，未执行；现改用当前固定依赖已提供的 **官方 Shiki JavaScript regex engine**，没有新增 JS eval 权限，保留原 Markdown/主题/语言/cache 管线。`W/components/ChatMarkdown.autoops-csp.browser.test.tsx` 实际渲染 TS/JSON 中文/bash/Python，WASM 调用为 0；全 Web 类型检查通过。该更改已随最终静态6部署；B9 实际历史代码块 5 块/77 个彩色 span、0 CSP/WASM 错误。首轮用普通 pre 选择器造成的假失败保留，后续改用原生 Shiki class 并真实滚动，不改变应用。

原生 ask_user 真实选项缺失来自旧 MCP 协议枚举映射，固定 Effect 4.0.5 的受跟踪 patch 已修；M3 的三项真实复验通过。v8 的 Plan Implement 虽真实完成模型运行，却丢失 sourcePlanRef，不能算该阶段功能通过；ws mapper 补丁及 103 个原生测试/类型通过后，P2 最终 v9/static6 真实复验 wire/run 来源与业务范围一致且执行完成。旧 stage8 报告后两行失败和 B8 报告 Plan 行失败均保留，不回填；最终 B7 计时改用两侧各自的单调时钟，避免 Date.now 的跨时钟偏差。

## A07 真实执行进程崩溃与恢复

在有真实执行及待答问题时发送 SIGKILL。首次 systemctl 操作因辅助进程返回 `Invalid argument`、退出码 1；这不等于未注入故障：实际 MainPID 从 122401 变为 122924，NRestarts 从 0 变为 1。恢复日志记录 terminalizedRuns=1、closedRequests=1、requeuedEffects=0；真实问题转为 expired/not_resumable，原 run/providerTurn 为 cancelled，已排队运行保持 queued 且 queueHeld=true。

同一次故障的独立跟进报告 `.test-artifacts/t3-live/restart-stage9-reconciled.json` 为 passed、errors=[]：迟到回答被拒绝；队列至少 5 秒保持 queued/queueHeld，providerTurn 数不增、用户消息不重复，原 nativeId 不变；从 cursor 6571 补流收到 event 与 synchronized。跟进未发新模型、未第二次 kill，仅取消测试自身队列。

原始 `.test-artifacts/t3-live/restart-stage9.json` 保留 failed 和 systemctl 错误。结论是实际 worker 自动重启后的恢复不变量通过，不能写成 kill 命令干净成功；不从延后跟进推断精确恢复耗时，也不宣称覆盖了主机断电。

## 来源与许可

T3 MIT 原文保留在 `vendor/t3code/LICENSE`；原始 blob 清单与本地适配差异独立记录，不通过重新导入覆盖适配。最终 release10 源码于 2026-10-21 14:00:37 UTC 校验：28439 blobs、baselineInventoryUnchanged=true、179 项本地适配/56 项新增，见 `.test-artifacts/t3-source-adaptations-release10-final-20261021.json`。原始清单未改写，MIT 原文保持原 hash；本地已适配所以 cleanUpstreamBaseline=false 是预期，不是来源损坏。新增清单包含许可缓存等生成文件，计数不是完成率。

Codex 规则核对官方 `rust-v0.159.2`，固定来源/内容 SHA256 与 Apache-2.0 LICENSE/NOTICE 在 `A/codex-native-policy-source/`。中文字体 OFL 与来源哈希在 `A/business-documents.sources.json`。依赖的独立许可证随发布生成，不能由 T3 MIT 替代。

## A11 配对数据保全与原生路径修复

2026-10-21 维护窗口对真实18987数据做完整快照/只读恢复时，发现Copied CODEX_HOME中的state_5.sqlite保留了源HOME的绝对rollout_path，导致一次迁入续接把原生头从33行追加到173行，复制目录仍33行。第一次58文件恢复报告不能证明推进头保全，其原始摘要还查了上游遗留空事件表；保留原报告，以独立inspect-corrected.json标明实际事件水位453，不覆盖原证据。

已暂停两套写入者，分别完整保全旧应用+runner与迁入T3+实际外部原生头，再验证173行字节是原33行的严格前缀追加后，只读复制推进头到迁入HOME。只修改迁入clone的SQLite索引；原source rollout SHA保持不变。修复后的完整快照包含新消息、附件和2条真实native会话，水位589、10threads、89messages、28runs、6providerTurns，另恢复到只读新目录，未启动恢复副本worker。

- `agent-demo/migrations/t3-native-paths.mjs`：按真实session_meta.id映射复制的索引，路径写最终目标而非partial目录；缺失/重复identity拒绝；涵盖skipped_rollouts引用。`A/launcher.mjs` 启动前对全部rollout引用执行当前HOME、文件存在、非symlink检查。cwd是受业务权限覆盖的workspace路径，历史session_meta.cwd不改写；agent_path/项目根不当作rollout搬移。
- `agent-demo/migrations/t3-recovery.mjs`、`scripts/t3-recovery-data.mjs`：停写后配对hash快照；已有目标拒绝覆盖；恢复仅新只读目录，无provider启动、无自动反向迁回旧SQLite。原生引用不在保全范围时拒绝快照。
- `.test-artifacts/t3-a11-20261021/`：原新pair清单、修复前后hash、独立readonly恢复及原用户数据对账。旧conversations9/files3/drafts7/preferences6逐内容hash/revision与迁移前完全一致；仅新增3条cid=null的runtime.updated缓存事件，无真实用户会话增量。
- `test/t3-recovery.test.mjs`、`test/t3-native-paths.test.mjs`、`test/t3-worker-policy.test.mjs` 共7项通过；原生导入集成9项通过并验证实际state_5.sqlite最终路径。合成fixture中的新增附件/消息/原生追加只用于确定性保护测试，不冒充模型会话。

无可靠无损反向迁移时，本轮策略是保留新版本完整数据及只读副本，不把旧SQLite覆盖新消息/附件/原生推进头；这不是宣称旧版UI可以继续编辑新版本会话。最终切换和服务恢复由主代理协调，旧bridge不得与新worker同时操作同一个原生头。


## 正式数据导入、切换与只读复验

新快照 `backups/t3-final-baseline-20261021` 使用当前旧 DB 与原配对 baseline native；旧 DB 的全部用户域逐行 hash 与 baseline 相同：9 会话、3 文件、7 草稿、6 个人偏好、1 附件提取缓存。原事件无删除/改写，只增 3 条 cid=null 的 runtime.updated，保留后总水位 76110。原配对 native 15 文件逐 hash 相同。测试推进至 173 行的头保持原 SHA，并在独立完整 pair 中保全，没有混作用户原会话继续导入。

最终 stage8 官方 bundle 已导入全新 `t3-production-data`，独立 verifier 再核对：3 个配置用户与 owner/成员关系；全部原会话正文/顺序，canonical 文本/思考摘要/工具输入输出/问题答案序列及消息映射；3 个附件原件字节、2 份报告副本；7 草稿与 6 个人偏好；1 个可信 native 续接绑定、8 个只读兼容绑定；原生头为原配对 33 行、索引严格在目标 HOME，outbox 为 0。报告 `final-cutover-verification.json` 状态为 passed，作为正式切换前置条件。独立对账阶段未启动该目标 provider；通过后由主代理协调正式切换。

本地脱敏摘要为 D1。详尽数据仅保留于授权 VM；快照/目标均不覆盖已有目录。正式入口 `8787` 已切换到 release stage10（core9/static6），旧 bridge 已 disable/inactive。`test/t3-final-readonly.mjs` 与 `test/t3-final-archive-readonly.mjs` 以独立临时 Chromium 只读核对全部 9 个固定导入 ID（不误把主代理另建并删除的 smoke 会话算作迁入增量），3 份旧文件字节、当前账号 1 Stash/刷新、只读绑定及窄屏布局均通过；全部原消息/run/providerTurn 计数不变，模型请求 0，观察到的应用命令只有个人 thread.visit。

其中 5 份原历史为活动状态，4 份已归档。8 份 readonly 绑定中，4 份活动历史实际显示原因；另 4 份直接路由会按上游归档规则跳出，需在 Settings → Archive 恢复后打开。独立补证确认它们与原生归档列表的 4 个 ID 完全相同，实际行及 Unarchive 按钮可见，归档时间和状态未改。首次“8 个都应从活动路由显示”的断言不适用于归档，原失败报告保留，不通过擅自取消归档来让测试变绿。

最终汇总见 `.test-artifacts/t3-live/production-readonly-release10-summary.json`。重复执行脚本也已按原生归档语义修正，最终 `production-readonly-release10-final/report.json` 7 项全部通过、0 pageErrors；桌面/窄屏/代码/归档截图在同目录。早期独立归档补证仍保留于 `production-readonly-release10-archive/`。390×844 下文档宽度为 390、无横向溢出；这不是实体手机软键盘验收。原 bridge 与新 worker 不得并行修改同一 native 头。
