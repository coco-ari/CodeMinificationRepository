# Agent 交互 Demo 验收记录

更新日期：2026-10-21。此文件记录已经取得的证据及缺口；不是“商业级体验已经达标”的声明，也不替代用户实际体验。

产品约束见 [实现与验收契约](agent-demo-contract.md)、[工作台需求](workbench-v2-requirements.md) 和 [前端规范](frontend-guide.md)。另见 [完整技术方案](agent-demo-technical-plan.md)、[部署与恢复说明](../agent-demo/DEPLOYMENT.md) 和 [体验流程](agent-demo-walkthrough.md)。

## 原生会话、资料与滚动修复（2026-10-21 15:12 部署）

已部署前端 `agentDemo-B-vrzzYE.js`、主服务 buildHash `a80c03033945e2e7707c26eb02024dc1c2fc6456d22b23822fee2aea0df34eac`、最终 Bridge SHA256 `73e90007e10531395e9c4718e45d0fa9fcd2e90508308bec6ed5a9848c71be5f`（15:27 增补删除恢复，主服务和前端不变）。仍使用 CPA / grok-4.6 / Codex App Server 0.159.2，未修改模型、思考档位或 Key。部署与八个文件校验见 [清单](../.test-artifacts/agent-demo-native-fixes/deployment.json)。

本次按固定版本 OpenChamber 的持久会话与滚动方案、Hermes 的会话文件引用流程修复。直接复用 OpenChamber 的 health-wait；PDF 正文交给 PDF.js 6.4.299 的隔离 worker。原生 thread 负责历史与自动压缩，本地主服务负责业务权限、附件、队列和可见记录；没有自制摘要或静默截断。详细来源、原因及适配见 [源码映射](agent-demo-open-source-flows.md) 和 [技术方案](agent-demo-technical-plan.md)。

| 修复与边界         | 已取得的受控证据                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生连续会话       | [225 个协议轮次](../.test-artifacts/agent-demo-api/native-sessions.json)，连续 205 轮同 thread；240 条旧历史首次迁移、重启 resume、重试新 revision、分支/撤权隔离、缺失 binding 明确失败与原生删除。该测试不调用模型，自动压缩只有真实事件映射测试，尚未做实际压力触发。                                                                                                |
| 主服务协议         | [4 组](../.test-artifacts/agent-demo-native-session-main/report.json)：pending 绑定先落盘，confirmed 后仅增量消息；重试排除废弃回答；早停、启动失败和 POST 回执丢失仍能清理原生 thread。                                                                                                                                                                                |
| 跨轮附件与权限     | [6 组](../.test-artifacts/agent-demo-api/session-files.json)：仅当前历史和本轮已发布附件可读；跨会话、未发布及未来队列文件拒绝；TXT/PDF/产物跨轮和主服务重启后可读；删会话同时删提取缓存。                                                                                                                                                                              |
| PDF 解析           | `agent-demo-attachments.test.mjs` 13 项在本地与部署机 Linux 均通过，含中文、混合/扫描、加密/损坏、限制、超时退出及恶意链接/JS 不执行。扫描件明确提示需要 OCR，不假装已读。                                                                                                                                                                                              |
| 真实滚动手势及断流 | [7 项](../.test-artifacts/agent-demo-transport/report.json)：修复完成时浏览器布局钳制被当作用户上翻；回最新后完成仍 gap=0，用户阅读第20段前后 y=101.75px。实际销毁 HTTP SSE socket，离线期间12个新增片段重连后完整无重复；日志全缺失时用快照修复尾段。执行器受控，不能当作真实模型延迟。                                                                                |
| 服务就绪           | [7 项](../.test-artifacts/agent-demo-readiness/report.json)：新鲜健康探测、恢复期间等待后只投递一次、约3秒不可用后明确失败且输入持久化、准备期停止后不启动模型、POST 失败即时更新状态、真实时序/每轮用量/压缩状态落盘。                                                                                                                                                 |
| 业务与整页回归     | [API](../.test-artifacts/agent-demo-api/api.json)、[分支合同11组](../.test-artifacts/agent-demo-api/conversation-actions.json)、[整页16组](../.test-artifacts/prototype-v2/agent-demo-full-flow/report.json)通过；包括原有引导、澄清、停止、排队、分支、搜索、手机动作与零浏览器运行错误。整页测试早于最后增量history接入；接入由上述主服务协议测试覆盖，前端产物相同。 |

部署过程中首次 SQLite 备份因磁盘不足失败，当时尚未切换代码；删除该次不完整备份、恢复服务，并无损压缩历次 SQLite 备份后释放至约6.1GiB可用，再完成部署。旧会话和附件保留。新备份包含代码、服务单元及一致 SQLite；后续备份还必须在服务停止时包含 `data/runner` 的原生会话。未读取模型 Key。

**已修复并真实确认附件、滚动和服务恢复，但整体长会话稳定性尚未通过。** 原来200条history硬限制已由原生会话取代，受控连续205轮通过；真实测试因发现新的CPA/Grok异常而在61轮停止，不能把它写成真实105轮已通过。

| 当前配置真实验收 | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8轮完整网页      | [报告](../.test-artifacts/agent-demo-real-evaluation/browser/2026-10-21T07-23-32-156Z-f0c74875/report.json)及[判定](../.test-artifacts/agent-demo-real-evaluation/browser/2026-10-21T07-23-32-156Z-f0c74875/analysis.json)：8轮均完成、同一个原生thread、零浏览器错误。TXT本轮及下一轮读取、PDF随机核验码、刷新后事实记忆均正确，附件调用无失败重试。                                                                                                                                             |
| 长文滚动         | 第6轮1286个中文字符，表格、代码与末尾标记完整；正文继续增长时上翻阅读的scrollTop位移0；回最新后终态距离底部2px。已解决此前Activity收束时失去跟随的问题。                                                                                                                                                                                                                                                                                                                                          |
| 等待与显示       | 第6轮反馈70ms，但首可见正文66.90秒，总计79.12秒。Bridge在66.33秒首次收到reasoning、66.75秒收到正文；第7轮首正文51.85秒，总计61.42秒。主要等待发生在运行器返回正文前，不能仅靠换滚动组件消除。单次比旧样本更快不代表提供方延迟已稳定。                                                                                                                                                                                                                                                             |
| 浏览器网络       | 第7轮Chrome离线约5秒，HTTP请求证实失败，恢复后最终标记完整且不重复；这不证明既有SSE socket在此次实验确实关闭。实际socket断开补流仍以独立受控transport测试为证据。                                                                                                                                                                                                                                                                                                                                 |
| 真实长测         | [61轮记录](../.test-artifacts/agent-demo-real-evaluation/long/long-2026-10-21T07-12-52-737Z-ac92d357/report.json)及[分析](../.test-artifacts/agent-demo-real-evaluation/long/long-2026-10-21T07-12-52-737Z-ac92d357/analysis.json)：57 completed、3 failed、1主动停止，全程同thread，无失败重试重建；10/30/60轮记忆精确正确。但40轮正文出现EOS/工具边界控制标记，38/51/59轮各重复约2000个EOS后失败，故提前停止目标105轮。57个完成样本的首正文REST观测p50=3.016秒、p95=5.071秒，不能用此覆盖失败。 |
| 原生历史证据     | 清理前只读核对本次自建thread的rollout，assistant ResponseItem中也有这些标记，确认不是网页自行生成。它们保留在原生上下文，可能影响后续重复；尚未证明最初根因是模型、CPA转换还是其他上游处理，也尚未核实实际CPA版本与公开源码对应。没有隐藏或过滤结果。                                                                                                                                                                                                                                             |
| 停止、继续与重启 | [独占故障验收](../.test-artifacts/agent-demo-real-evaluation/faults/real-fault-2026-10-21T07-28-03-317Z-296200d9/report.json)4轮通过：真实正文后停止与继续；Bridge重启后同thread恢复，回忆未重述随机事实，真实read_attachment读取未重附TXT的未披露第二行，旧轮interrupted且队列暂停。重启前后均核对全用户活动，仅操作自建测试会话。                                                                                                                                                               |

15:27的[删除恢复补丁](../.test-artifacts/agent-demo-native-fixes/deployment-delete.json)按官方thread/delete语义处理部分删除与重试；14组/225受控轮次及[真实CLI无推理重复删除探针](../.test-artifacts/agent-demo-api/codex-delete-idempotency.json)通过。原生删除进度持久化，精确已不存在错误只对本适配器拥有的ID视作幂等成功，其他失败保留记录以便恢复。61轮长测和8轮网页在这项补丁之前完成，执行路径未改变；独占故障验收在最终Bridge版本完成。

自研储备：保留运行器adapter、业务轮次/队列契约、授权文件读取、真实时序、事件补流和源码映射；当前CPA/Grok链路仍是技术选型的未通过项。下一步应在提供方边界核对SSE、最终output item与下一轮input，修复必须在原生历史写入前生效，不能用前端文本过滤掩盖。依据与门槛见[技术方案末节](agent-demo-technical-plan.md#本次验证对技术选型的约束2026-10-21)。扫描PDF仍需要OCR，实体手机与真正压满上下文触发自动压缩尚未验证。

最终版本的[真实网页流程复验](../.test-artifacts/prototype-v2/agent-demo-native-fixes-live-web/report.json)于UTC07:30:12–07:31:29通过4组：资料读取与澄清、同轮引导、回答后排队自动启动、网页停止、桌面/390px与刷新保留，零运行时错误。该场景首可见正文约15.18秒，含真实资料工具过程，不能和纯文本长文延迟直接比较。

[最终只读核对](../.test-artifacts/agent-demo-native-fixes/final-state.json)于UTC07:32:26确认两服务active、liveAvailable=true、全用户活动轮0，10个源码/静态文件与本地摘要一致，磁盘余量约5.8GiB。所有测试会话均保存证据后删除，原有用户会话保留。以下旧版本报告仅作为修复前对照。

## 修复前：真实多轮、长文和异常评估（2026-10-21）

本次直接通过 ZeroTier 访问已部署 Demo，使用现有 **CPA / grok-4.6 / Codex App Server 0.159.2**，没有替换模型、修改配置或部署产品改动。前端仍为 `agentDemo-EEgVo9kz.js`，后端仍为 `50ea4cb05e2e935efebd9ef2c6180b7c280d015c951ffb41d6671863ebabdb49`。输入中的随机标记和附件是合成验收数据；模型、工具调用、网页和持久化链路均为真实运行，不使用场景执行器。

**结论：基础流程可用，但当前版本尚不能称为稳定流畅。** 跨轮附件、历史条数边界和重启就绪状态已暴露实际问题；长文首段等待明显不稳定。以下区分通过、失败、能力限制和未证实项，不把测试脚本正常退出当作产品全部通过。

完整机器可读汇总见 [summary.json](../.test-artifacts/agent-demo-real-evaluation/summary.json)，包含各报告摘要、校验和、延迟定义、清理和最终服务状态。

| 范围              | 实测结果                                                                                                                                                                                                                  | 证据                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 当前版本基础流程  | 真实资料读取、澄清期间同轮引导、回答后继续、排队自动启动、网页停止及刷新通过。首段可见正文约 **7.80 秒**，首轮约 **52.20 秒**。                                                                                           | [真实网页基线](../.test-artifacts/prototype-v2/agent-demo-real-baseline/report.json)                                          |
| 连续多轮及记忆    | **102 轮请求，101 轮成功，1 轮失败**；第 10/30/60/100 轮均精确回忆随机标记。第 101 轮携带 200 条历史成功，第 102 轮携带 202 条历史被 Bridge 拒绝（400），没有启动 runner。                                                | [长测分析](../.test-artifacts/agent-demo-real-evaluation/long/long-2026-10-21T06-21-45-551Z-a8804154/analysis.json)           |
| 真实长历史页面    | 刷新后先显示 30 轮，三次加载后显示 101 轮；锚点偏差不超过 0.5px。59 个滚动帧样本的最大间隔 16.8ms，无超过 50ms 的样本。                                                                                                   | [长历史浏览器](../.test-artifacts/agent-demo-real-evaluation/history-browser/report.json)                                     |
| TXT 本轮/跨轮读取 | 本轮准确读出第一行；下一轮不重传文件时，9 次 `read_attachment` 均失败，35.53 秒后要求重新上传。第二行随机内容从未出现在提示或先前回答中，不能靠文字历史猜中。                                                             | [网页第 3–4 轮](../.test-artifacts/agent-demo-real-evaluation/browser/2026-10-21T06-26-31-628Z-bcae1771/report.json)          |
| PDF 文件          | 有效 PDF 上传成功，但正文读取返回“不支持”，无法取得文件中的随机核验码；模型没有编造读取结果。                                                                                                                             | 上述网页第 5 轮                                                                                                               |
| 长文及流式显示    | 1405 个中文字符、表格和 JSON 代码块完成；首可见正文 **100.97 秒**，总耗时 **115.12 秒**。正文分块显示间隔中位数 770ms、p95 1682ms；末尾标记完整存在于 DOM 和持久化结果。                                                  | 上述网页第 6 轮及 [解释](../.test-artifacts/agent-demo-real-evaluation/browser/2026-10-21T06-26-31-628Z-bcae1771/analysis.md) |
| 阅读和回最新      | 新内容到来时，上翻阅读约 3.3 秒，scrollTop 位移为 0。点击回最新后，终态截图仍显示正文开头和回最新按钮；因缺完整焦点/跟随事件，列为**待复现疑点**。                                                                        | [长文完成截图](../.test-artifacts/agent-demo-real-evaluation/browser/2026-10-21T06-26-31-628Z-bcae1771/round-6-completed.png) |
| 浏览器离线实验    | 对 Chrome 设置离线 5 秒时尚无正文，未取得既有 SSE 实际断开的证据；120 秒仍无正文，按测试限时停止，保留了 reasoning。**断点补流与尾段完整性未证实**，不能判为通过，也不能归因于断网。刷新后消息 ID 保持，第 8 轮记忆正确。 | 上述网页第 7–8 轮                                                                                                             |
| 正文后停止与继续  | 真实正文开始后停止，进入 interrupted；随后 3 秒无新增正文事件。继续创建新轮次并完成 1061 字符，旧的部分结果保留。                                                                                                         | [异常验收](../.test-artifacts/agent-demo-real-evaluation/faults/real-fault-2026-10-21T06-33-46-383Z-e804b5ac/report.json)     |
| Bridge 重启       | 在真实澄清等待阶段重启一次：旧轮正确中断，队列保留且暂停。紧接着的新请求却 `fetch failed`，无 runner ID，而主服务仍报告可用；因此本场景**失败**。两服务已恢复 active。                                                    | 上述异常验收及 `bridge-recovered-*.json`                                                                                      |

重启问题的 [只读时间证据](../.test-artifacts/agent-demo-real-evaluation/faults/real-fault-2026-10-21T06-33-46-383Z-e804b5ac/fault-postcheck.json) 表明，立即恢复请求的连接失败发生在 Bridge 开始监听前约 24ms。之后增加且仅增加一次 [独立延后探针](../.test-artifacts/agent-demo-real-evaluation/faults/real-fault-2026-10-21T06-33-46-383Z-e804b5ac/post-restart-recovery-probe.json)：重启后约 200.5 秒发起，3.45 秒完成并正确返回随机标记。它证明服务后来恢复可用，不代表必须等 200 秒，也不覆盖原场景失败；原始报告校验和保持不变。

简短连续轮次中，第 1–89 轮没有其他已知验收活动，首正文 API 观察时间 p50 **2.360 秒**、p95 **7.070 秒**、最大 **12.854 秒**；其余成功轮次与网页早期测试重叠，单独统计。该指标包含 250ms REST 采样误差，不是网页绘制时间或提供方首 token 时间。101 次成功各自使用不同 runner thread，证明文字历史回放的记忆有效，不证明运行器原生上下文连续。累计 usage 为 623,538 tokens（缓存输入及 reasoning 是子项，不能再相加）。

长文第 6 轮发生在长会话测试结束以后。约 65 秒时另一次只读观察仍为 `awaiting_model`、空 timeline，表明该时刻服务端也没有正文或思考；本次没有完整连续相位记录，不能把整段 101 秒全部归到模型、网络或前端任一层。最终思考与正文均存在。下一次定位需要对应 runner、主服务事件和可见 DOM 的同一时间轴，避免靠增加动画掩盖等待。

确定问题与处理方向：

1. 跨轮附件仅从本轮 `run.attachments` 查找，应适配为受会话权限约束的文件上下文，并避免对不可访问附件连续盲目重试；不能只复制文件展示组件。
2. Bridge 固定拒绝超过 200 条历史，主服务却全量回放且没有提前提示。应复用所选运行器的会话/上下文压缩机制并明确边界，不能仅提高常量；澄清和引导会增加历史条目，因此并非所有会话都恰好第 102 轮失败。
3. PDF 上传成功与模型读取能力不一致，应接入可用的文件解析流程，或在上传时准确说明能力；不能展示为已读取。
4. 重启后主服务每 10 秒刷新一次运行器就绪缓存，存在“显示可用但监听尚未完成”的窗口。应让就绪状态对应真实可连接状态、在连接错误时更新状态，再验收用户重新发送的结果。
5. 回最新异常需先排除测试点击前的滚动/焦点影响，再复现自动折叠和布局变化与跟随状态的关系；本轮没有凭疑点修改产品。

测试边界：101 轮长会话主要为短回答，不代表 101 轮复杂研究任务；390px 是 Chrome 视口/触控模拟，非实体手机。长历史的 bootstrap 为约 729KiB，包含当前账号可见会话的聚合快照，不能视为单会话下载量。流式分块指标不是 token 吞吐量；“末尾在 DOM”不表示末尾当时处于屏幕视口。没有在相同条件下实测上游产品，不能据此给出与 OpenChamber/Hermes 的速度排名。

仅新建、保存证据后删除本次私有测试会话；重启前用 API、服务器全用户 SQLite 活动元数据及本机 health 共同确认独占，并在远程操作前重复检查。只正常重启 Bridge 一次，没有重启主服务、读取模型 Key 或改动用户原会话。本轮新增验证脚本与记录，没有修复或部署上述产品问题。

[最终只读核对](../.test-artifacts/agent-demo-real-evaluation/final-state.json) 于 UTC 06:39:26 完成：主服务与 Bridge 均 active，活动轮次 0，`liveAvailable=true`；主服务、Bridge 和夹具源码 SHA256 与测试前全部相同。

## 分支操作层级与边界修复（2026-10-21 12:04）

已部署前端 `agentDemo-EEgVo9kz.js` / `agentDemo-d6XXzccF.css`，后端 buildHash `50ea4cb05e2e935efebd9ef2c6180b7c280d015c951ffb41d6671863ebabdb49`。按 OpenChamber 源码收敛桌面图标、助手分支菜单、触屏 Sheet 和终态操作位置，同时修复中途引导/澄清分支携带后续工具/思考的边界错误。设计理由、不适配原因与解决方案见 [源码适配说明](agent-demo-open-source-flows.md#消息分支入口上游原因适配边界与处理2026-10-21)。

| 证据       | 结果与边界                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建       | `pnpm build:ui` 的 TypeScript 与 Vite 均通过。                                                                                                                                                                                                                         |
| 整页回归   | [16组](../.test-artifacts/prototype-v2/agent-demo-full-flow/report.json)，精确 `EEgVo9kz` 与 `50ea4cb0`，零浏览器运行时错误。保留原业务检查，增加桌面 hover/Tab、开菜单不创建/选项只建一次、手机与1280px触控面板、焦点恢复、引导分段、活动状态禁用、附件及空失败恢复。 |
| 分支合同   | [11组](../.test-artifacts/agent-demo-api/conversation-actions.json)，HTTP/SQLite/受控Bridge。跨引导/澄清的工具与思考状态、重启恢复、缺快照409且原会话不变、普通user/assistant分界、草稿、暂停队列、幂等、权限及附件存活。                                              |
| 原会话回放 | [8项](../.test-artifacts/prototype-v2/agent-demo-upstream-replay/report.json)，精确 `EEgVo9kz`；复制最终回复、资料预览、工具结果、思考与搜索保持正常，增加默认隐藏/悬停显示动作栏。未修改服务器上的用户原会话。                                                        |
| 部署       | [清单](../.test-artifacts/agent-demo-message-actions/deployment.json)，UTC04:04:26；活动轮次0，代码和SQLite一致备份，上传摘要全部一致，重启主服务后 `liveAvailable=true`。运行器、模型、Secret配置未更改。                                                             |

[部署后 ZeroTier 实测](../.test-artifacts/prototype-v2/agent-demo-message-actions-deployed/report.json)于 UTC04:05:41 通过3项：打开菜单不新建；选择后只创建一个分支、仅保留第一轮、原会话不变且不自动运行；390px文字操作面板行高44px并可关闭。资产/后端哈希与发布一致，零浏览器异常，测试只清理自己创建的私有场景会话。

本轮针对消息操作与分支数据修复，受控测试零真实模型调用；没有把旧版本的真实 Grok 验收算作本轮模型复验。实体手机软键盘和用户主观体验仍需实际使用评价。

测试发现并修正本地主题兼容问题：`pointer:coarse` 全局按钮规则把 Sheet 行高压到40px；提高本组件规则优先级后，窄屏和宽触屏实际操作行均为44px。中间助手片段不再获得会复制整轮的错误分支入口；纯错误/无正文仍可重新生成。

以下为上一版记录；同名自动化报告会由后续复跑更新，当前交付以本节及新部署清单为准。

## OpenChamber 展示流程纠偏（2026-10-21 11:32）

本次按用户实际“整理一份发布准备报告”轮次核对上游源码，发现上一版自制 `Steps`、双层详情和整轮不收束的问题。现在使用固定 OpenChamber `6491f51d` 源码迁移 Activity、读取行、JSON结果、ReasoningTimelineBlock、WorkingPlaceholder 与分块揭示；逐项路径、直接复制和必要适配见 [源码映射](agent-demo-open-source-flows.md)。

最终前端 `agentDemo-CfzhG8sr.js` / `agentDemo-Cf7lvIyb.css`；后端 `b63c2f4775680d33d0cc6ab26fb5922ec3397ca7e270f2bc5c23f7c919944395`；运行器/Grok/Secret 配置未改变。11:29 更新后端phase透传与工具时间字段，11:32仅更新停止状态前端小修正，最终部署不重启服务。

| 证据             | 结果与边界                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户原轮只读回放 | [8项](../.test-artifacts/prototype-v2/agent-demo-upstream-replay/report.json)，原12段时间线在本地隔离数据库回放；折叠/展开、两份资料预览、JSON三模式、无自加思考条、嵌套搜索、390px；零模型调用。测试于最终停止状态修正前的 `DxJVw1Jz`，渲染实现相同。                        |
| 全页业务回归     | [11组](../.test-artifacts/prototype-v2/agent-demo-full-flow/report.json)，`DxJVw1Jz`，HTTP/SSE受控runner；Activity、思考/正文分块、搜索、导出、偏好、分支/重试、37轮窗口、置顶归档及手机，无runtime错误。                                                                     |
| 最终交互回归     | [9组](../.test-artifacts/prototype-v2/agent-demo-chat-ux/report.json)，精确 `CfzhG8sr`；12.5秒静默无假状态、上翻不抢滚动、引导/澄清、stopping阶段隐藏工作状态、尾段冲刷、Activity历史和手机。渲染约53ms为受控浏览器测量，不能当模型响应速度。                                 |
| 上游工具组件     | [浏览器5组](../.test-artifacts/prototype-v2/agent-demo-tool-parts/report.json)，授权文件预览、失败读取、缺step恢复、三种JSON模式、600项虚拟树、390px；Node单元6组。                                                                                                           |
| 纯函数/时序      | `node --test test/agent-demo-activity.test.mjs test/agent-demo-tool-parts.test.mjs test/agent-demo-timeline-view.test.mjs` 共24项通过。                                                                                                                                       |
| 协议             | [Codex10组](../.test-artifacts/agent-demo-api/codex-reasoning.json)、[桥接30断言](../.test-artifacts/agent-demo-api/codex-bridge.json)、[服务11组](../.test-artifacts/agent-demo-api/bridge-protocol.json)；真实phase保留，晚到相位更新原条目，缺失不编造，刷新/SSE回放保留。 |
| 部署             | [最终静态更新](../.test-artifacts/agent-demo-upstream-parity/deployment.json)、[首次更新](../.test-artifacts/agent-demo-upstream-parity/initial-deployment.json)：更新前idle、代码/SQLite备份、文件摘要全部一致、liveAvailable=true。                                         |

[部署后真实 Grok 验收](../.test-artifacts/prototype-v2/agent-demo-live-web/report.json)通过 **ZeroTier `172.29.22.6:8787`** 访问，UTC 03:32:54–03:33:52，资产 `CfzhG8sr`、后端 `b63c2f47`。4组通过、零浏览器错误：真实读取两份资料、澄清期间同轮引导、回答后查询环境、表格/代码输出、排队自动开始与停止、桌面/390px/刷新恢复。模型返回4段思考及用量；本次提供方未返回 `messagePhase`，最终收束使用“完成轮末尾正文”的明确兼容规则，不假造相位。仅删除本次测试会话，用户原报告会话未更改。首段显示约10.47秒为本次真实模型/网络/分块合计观测，不能与受控约53ms渲染数字混用。

测试发现并已修复：思考分块二次提交导致短块被再次隐藏；搜索在父活动展开前向未挂载思考派发请求的竞态；停止阶段只更新phase导致状态残留；清理旧Steps样式时影响相邻Markdown样式。对应浏览器断言保留，没有通过删断言规避问题。

通用报告路径会由当前复验更新，下方旧版本描述只保留历史事实，不能据此将旧版测试计作当前版通过。

## 完整对话流程迁移与部署（2026-10-21 10:23，历史版本）

当前前端 `agentDemo-BGzqElAv.js` / `agentDemo-CeirNk1S.css`，后端 `aa04919c2af501f4b6fd671e2f4d98c485aabfb7383664b624bc0f60a6d56e72`，桥接 SHA256 `79abcc4a39ead03c43021033e0af781981ed320e2174a7ab79197e790667b7df`。固定源码来源与逐条移植方式见 [迁移矩阵](agent-demo-open-source-flows.md)。新增文件已保留版权和 MIT 原文，运行器、模型和 Secret 配置未改变。

| 验证层次       | 实际结果                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增整页流程   | [11组通过](../.test-artifacts/prototype-v2/agent-demo-full-flow/report.json)：思考/用量、摘要替换、搜索与导出、偏好刷新、编辑分支/回答分支/重新生成、37轮历史窗口及隐藏思考搜索、个人置顶归档、跨会话正文检索、手机布局；受控Bridge，零真实模型     |
| 显示数据与导出 | `node --test test/agent-demo-timeline-view.test.mjs` 6项通过，包含offset缺片拒绝、usage快照、导出顺序和不包含原始工具数据                                                                                                                           |
| 输入组件       | [10组通过](../.test-artifacts/agent-demo-controls/report.json)，包含IME、快捷键、账号偏好、附件降级、独立停止、澄清失败与晚到回执、手机触点                                                                                                         |
| 长历史         | [7组通过](../.test-artifacts/agent-demo-history-window/report.json)，90轮夹具、完整轮次、读者锚点误差≤1px、搜索加载、切换及短快照恢复                                                                                                               |
| 缺片恢复       | [6组通过](../.test-artifacts/agent-demo-gap-recovery/report.json)，延迟/陈旧/失败快照不被后续usage或reasoning覆盖、失败退避、删除与卸载停止修复                                                                                                     |
| API回归        | [10组通过](../.test-artifacts/agent-demo-full-migration/api/api.json)，包含100次受控边界竞态；最终后端哈希一致                                                                                                                                      |
| 新服务端动作   | [8组通过](../.test-artifacts/agent-demo-api/conversation-actions.json)，分支/重试/立即执行、ACL/附件独立复制、图片base64转交、重启与推理历史                                                                                                        |
| 个人置顶归档   | [5组通过](../.test-artifacts/agent-demo-api/conversation-preferences.json)，HTTP/SSE及回放按用户投影、重复PATCH无操作、ACL/CSRF、执行中归档不停止、重启/删除清理                                                                                    |
| Bridge         | [推理与用量9组](../.test-artifacts/agent-demo-api/codex-reasoning.json)、既有桥接27断言和主服务协议10组通过；这些是受控协议验证，零模型                                                                                                             |
| 部署和ZeroTier | [部署摘要](../.test-artifacts/agent-demo-full-migration/deployment.json)确认空闲、代码/数据库备份、逐文件哈希一致；[ZeroTier登录页](../.test-artifacts/agent-demo-full-migration/zerotier-login/report.json)在390和1280宽度及已知字段过滤规则下通过 |

[真实Grok网页报告](../.test-artifacts/prototype-v2/agent-demo-live-web/report.json)绑定上述前后端版本，UTC `02:23:34–02:24:25` 经LAN执行两个真实轮次：首轮读取项目资料、澄清、同轮引导、回答后查环境并完成正文/表格/代码；第二轮从队列启动后由网页停止。刷新保留问题、引导与续文顺序，桌面和390px视口无未捕获异常，只删除验收会话。

最终构建另完成原有整页回归31项：[完整流程16项](../.test-artifacts/prototype-v2/agent-demo/report.json)、[抽屉/焦点/移动端9项](../.test-artifacts/prototype-v2/agent-demo-ui-supplement/report.json)、[等待/时序/滚动6项](../.test-artifacts/prototype-v2/agent-demo-chat-ux/report.json)，全部通过，均绑定 `BGzqElAv / aa04919c`，没有浏览器异常或真实模型调用。

本次提供方实际返回 **3段reasoning（49、26、707字符）及token usage**，桥接与主服务均已持久化；思考和正文独立。该结果证明当前Grok链路能返回思考，但不是每轮都一定提供。网页首次正文可见约4.78秒，包含上游等待和页面操作，是单次观测，不是稳定p95。停止发生在第二轮正文输出前，不推断提供方所有阶段的取消及计费行为。

字段缺失、断线缺片和长历史边界使用受控测试覆盖；图片有主服务到Bridge的字节测试，尚未单独做本轮真实Grok视觉验收。PDF/Office内容提取、服务端历史分页、实体手机软键盘和用户主观流畅度仍不在上述通过结论内。完整迁移边界见矩阵，未将上游语音、外部Agent或定时任务宣称为已移植。

## 开源交互代码移植与真实网页验收（2026-10-21 09:22，历史版本）

此前部署后端 `cf49921a9147a1cbe9f7e11f5fef704c89e081a67d3698fda27448dd000623fb`；前端 `agentDemo-Bsk480MT.js` / `agentDemo-DX-isdzH.css`。当时直接适配流式更新、滚动和增量Markdown。下方保留当时观测，通用报告路径可能已由最新复验覆盖；旧真实网页证据另存 `.test-artifacts/agent-demo-chat-migration/live-web-before-full-migration/`。当前状态以本页顶部版本为准。

| 验证          | 实际结果与证据                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有序显示适配  | `node --test test/agent-demo-timeline-view.test.mjs` 4项通过：工具/用户/正文顺序、增量原位更新、旧历史、未变化轮次行复用                                                                      |
| 增量 Markdown | [隔离浏览器报告](../.test-artifacts/prototype-v2/agent-demo-streaming-markdown/report.json)：6组通过，正文/代码/表格节点与选区稳定，终态完整输出、代码复制、中文和安全链接                    |
| 跟随滚动      | [滚动报告](../.test-artifacts/agent-demo-scroll/report.json)：13项通过，含上翻、键盘、滚动条、嵌套工具区、触摸、会话位置恢复、输入区变高与减少动画                                            |
| 聊天整页      | [受控 Bridge 网页报告](../.test-artifacts/prototype-v2/agent-demo-chat-ux/report.json)：6组通过；首段事件发出到页面检测约52.9ms，阅读位置在继续输出时保持273px；零模型调用                    |
| 原有交互回归  | [完整浏览器报告](../.test-artifacts/prototype-v2/agent-demo/report.json) 16项、[补充报告](../.test-artifacts/prototype-v2/agent-demo-ui-supplement/report.json) 9项通过；未捕获浏览器异常为空 |
| 后端          | 当前实现的 API 10组（含100次竞态）、受控 Bridge 10组、重启恢复3组通过；见 `.test-artifacts/agent-demo-api/{api,bridge-protocol,restart}.json`                                                 |
| 部署          | [备份与文件摘要](../.test-artifacts/agent-demo-chat-migration/deployment.json)：更新前活动轮次为0，代码及 SQLite 一致快照已备份，远端文件逐项哈希一致                                         |

[真实 Grok 网页验收](../.test-artifacts/prototype-v2/agent-demo-live-web/report.json) 经 LAN 访问已部署页面，UTC `01:22:28.636–01:23:19.111`，使用实际 `grok-4.6` 与原 Codex App Server，两个真实轮次：

1. 第一轮读取项目资料和手册，调用 `ask_user`；在等待澄清时通过网页引导，提交澄清回答后查询测试环境并完成约1806字末段回答，表格与 JSON 代码块正确显示。
2. 网页提交下一轮队列，服务器在首轮完成后自动启动；网页停止使第二轮进入 `interrupted`。本次停止发生在正文输出前，不扩大为所有输出阶段取消或提供方计费停止的证明。
3. 引导、问题、回答、续文按发生顺序显示，刷新后保持。桌面1280×900、手机390×844视口截图已检查；仅清理本次测试会话，未修改用户会话。没有浏览器未捕获异常。

本次从点击发送前的观测起点到首段可见约 **7.03秒**，包含页面操作与上游等待，不是纯提供方首 token 时间，也不是稳定 p95。单次真实流程验证功能与显示顺序；流式滚动和高频 DOM 稳定性由可重复受控测试分别证明。仍未验证实体手机软键盘、长期大规模会话与用户主观流畅度；这些不由自动化通过替代。

首轮旧浏览器断言曾将“DOM article数”等同于服务器汇总message数，遇到新分段展示失败。已改为校验 user ID 唯一及 timeline part ID 完整、唯一，重新运行通过；原失败另存 `report-before-timeline-assertion-update.json`。

## ZeroTier 登录字段被隐藏修复（2026-10-21，历史版本）

用户截图显示登录页的账号、密码及标签整组消失。核对发现 Demo 的 `.ad-field` 与 `.ad-context` 命中 [EasyList 官方通用隐藏规则](https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_general_hide.txt)。旧版经 `172.29.22.6:8787` 加载后，注入对应 CSS 即复现相同现象；这是已证实的命名冲突，尚未识别用户具体使用的扩展。

将 Demo 的 class、id、CSS 变量、动画及相关测试选择器统一迁移为 `workbench-demo-` 前缀。新资源为 `agentDemo-CaIQM1G4.js` / `agentDemo-CnfUa5uR.css`，只更新静态文件，服务 PID 保持 87403，后端及 Grok 配置未变。

- [旧版 ZeroTier 复现](../.test-artifacts/agent-demo-filter-compat/before-zerotier/report.json)：390×844、1280×900 的字段由可见变为隐藏，标题与禁用登录按钮保留。
- [修复版 ZeroTier 公开页验证](../.test-artifacts/agent-demo-filter-compat/after-zerotier/report.json)：相同模拟规则下，两尺寸标签和输入框可见、可点击聚焦，页面无溢出；不是安装所有广告扩展的兼容性测试。
- [本机隔离登录验证](../.test-artifacts/agent-demo-filter-login/report.json)：真实表单登录、上下文侧栏、新建会话表单、刷新保持和登出通过，使用临时数据库，零模型调用。
- [ZeroTier 实际登录](../.test-artifacts/agent-demo-filter-compat/zerotier-login.json)：独立浏览器通过页面公开演示账号完成登录、刷新和登出，没有发送消息、调用模型或读取 Cookie。
- [静态部署记录](../.test-artifacts/agent-demo-filter-compat/deployment.json)：先备份，再替换资源及入口 HTML，远端与本地摘要一致。类型、构建及格式检查通过。

## Grok CPA 真实桥接验收（2026-10-21）

用户已选择关联 AI 工作台的 CPA `grok-4.6`，并授权读取关联配置接入。独立 Linux `codex-cli 0.159.2` 已通过 CPA 完成三个真实轮次；运行器与主服务均在测试机运行，桥接健康状态从 `configured / modelVerified:false` 变为 `verified / modelVerified:true`。这次是真实提供方执行，合成业务资料与环境快照只是输入数据，不是场景执行器。没有登录 Demo，也没有用个人 Codex 登录状态。

[真实验收报告](../.test-artifacts/agent-demo-grok-live/grok-live-2026-10-20T23-52-31-907Z-2845ad6b/report.json) 由 [验收脚本](../test/agent-demo-grok-live.mjs) 在 VM 内通过 `127.0.0.1:8791` 完成，UTC `2026-10-20T23:52:31.908Z` 至 `23:53:15.670Z`，共 43.762 秒，三个独立 run 全部通过。共收到 273 个连续且归属正确的事件，其中 250 个正文增量；没有传输错误。三个 run 不等于三次提供方请求，工具往返的实际模型请求数和 token 用量未统计。

| 真实轮次                   | 直接证据                                                                                                                | 本次结果                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 资料、文本附件、环境与报告 | 五种白名单工具成功；报告含三个只存在于工具数据中的随机标记、观测时间与夹具声明；回答引用实际读取资料和附件 URL          | 128 个正文增量，141 个事件，`completed`                                          |
| 澄清与同轮引导             | `ask_user` 等待时提交 steer，回执、唯一 started 与 completed 的 runnerTurnId 一致；回答后最终文本实际含引导和答案双标记 | 引导回执 10.861ms，答案回执 5.894ms，63 个正文增量，68 个事件                    |
| 执行中停止                 | 回答澄清后开始输出测试文本，在前三行输出期间停止；HTTP 回执为 `stopping`，随后收到桥接 `interrupted`                    | 回执 110.870ms；请求至终态 111.817ms；回执后零新增正文，一秒后的终态游标重放为空 |

首轮 7,932.645ms 的首段正文是“先拉取资料清单”的开场内容，出现在第一个工具事件之前；不能把这 7.93 秒说成已包含多轮工具。实际报告事件在 16,176.685ms，最终结论首段在 19,874.150ms，完成终态在 20,012.074ms。另两轮的首段正文分别为 4,118.978ms、8,750.981ms，均为澄清前的开场内容。`firstTextMs` 的脚本起点是创建轮次对象，包含提交前一次报告落盘与后续传输，属于客户端观测值，不是纯提供方首 token 时间。每类只有一个真实样本，不能据此推算稳定的 p95。三个创建回执 4.897/8.023/6.783ms 来自 VM 内回环，不是 LAN 或 WebUI 延迟。

停止证据须保留协议边界：末段正文为 seq 63，HTTP 回执时已收到至 63；随后 seq 64 为 `interrupted`，在 HTTP 回执后 0.797ms 到达，没有后续正文。桥接会把停止期间到达的上游 `completed` 规范为 `interrupted`，本报告没有保留上游原始终态。因此已证明客户端可见停止、桥接终态与事件停止，不能单凭它断言提供方内部取消或计费立即停止。实际引导采纳仅覆盖本次澄清等待期间的同轮补充，不代表所有工具执行时刻均已验证。

[部署关联证明](../.test-artifacts/agent-demo-grok-live/grok-live-2026-10-20T23-52-31-907Z-2845ad6b/deployment-attestation.json) 与本地只读复核一致：桥接 SHA256 为 `4b14bb86ffdde8da38c9a0e34f6b1b2323516373dd22315fe442f6dd2fe536b2`，脚本为 `a3db948d4392a8a81e3112953d53749ffd55df2e7f045c6972ece6efdbdbf510`，报告为 `c7584e8ffa98f8559209bc48b7b4c26332302f50a62275e5299230bb4ff33274`；主服务、夹具、桥接和脚本四份本地源文件均与部署哈希相符。主服务与桥接均 active、重启计数为零。

此前准备阶段证据继续保留，不能替代或扩大上述三个真实轮次的范围：

- [CPA 提供方检查](../.test-artifacts/agent-demo-api/codex-cpa-provider.json)：22 项通过，使用假 CLI 与合成测试数据，检查环境隔离、私有密钥文件、错误脱敏和控制协议。
- [桥接协议回归](../.test-artifacts/agent-demo-api/codex-cpa-protocol.json)：27 项通过，使用注入运行器，零模型调用。
- [CPA 真实 CLI 启动检查](../.test-artifacts/agent-demo-api/codex-cpa-startup.json)：实际 CLI 在原禁网沙箱中接受 CPA Responses 配置、模型与权限设置；没有调用 account/read 或 turn/start，未读取个人凭据。
- [Linux 安装证据](../.test-artifacts/agent-demo-grok/runtime-install.json)：官方安装包 SHA256 匹配且版本命令通过，不能代替模型验证。
- [更新后的公开页面检查](../.test-artifacts/agent-demo-public-login/report.json)：`8L7Ruwid / 31z-RJyc` 的 Chrome 390×844、1280×900 检查通过。没有登录，故新增的当前模型显示仅通过类型与构建检查；之前登录页证据保存在同目录 `before-cpa-BNpfdmZI`。

上述三份 CPA 协议/启动证据对应同一桥接 SHA256，但它们各自仍是零模型调用。下面历史版本的场景压力、浏览器与 iOS 记录保持原版本范围；本次真实桥接通过没有重跑 WebUI、服务端队列、continue、权限、持续并发或底层文件/网络隔离。

## 证据边界与版本

| 层次                  | 实际验证对象                                         | 可以证明                                   | 不能证明                               |
| --------------------- | ---------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| 本机 HTTP 场景测试    | 本机 Node 服务与 SQLite，显式 `mode=scenario`        | 服务端状态机、权限、持久化、并发和事件协议 | 真实模型行为、VM 网络性能、浏览器体验  |
| VM LAN 场景测试       | `http://192.168.31.157:8787`，显式 `mode=scenario`   | 已部署 API 经局域网访问的功能与确认延迟    | 模型首字延迟、真正推理与工具调用       |
| 受控 Bridge 测试      | 临时主服务连接测试替身，走 `live` 适配路径           | 流拆包、异步控制、停止/结束竞态及失败恢复  | Codex 实际支持这些协议、模型遵循引导   |
| Codex 桥接注入检查    | 桥接使用注入运行器，不启动 Codex 子进程              | 桥接协议、去重、授权资料与事件处理         | 真实 CLI 配置兼容、系统隔离、模型行为  |
| 真实 CLI 启动检查     | 本机 `codex-cli 0.159.2`，无鉴权、无模型轮次         | 初始化、配置解析与六个动态工具注册兼容     | 工具执行隔离、模型调用、真实引导/停止  |
| 重启与定向竞态        | 独立临时目录/端口/子进程                             | 崩溃恢复、迟到请求、删除回放、登出连接     | 生产数据规模、所有故障组合             |
| 真实模型              | VM 内 CPA grok-4.6、Codex CLI 0.159.2 的三个真实 run | 工具读取、报告、澄清、同轮引导及可见停止   | WebUI、队列、继续、隔离、全时刻引导    |
| 浏览器场景交互        | Chrome 访问 VM、真实 API 与响应式模拟                | 已采样的布局、输入/阅读及功能交互          | 真实模型、真实手机软键盘、用户主观认可 |
| iOS Safari 公开页检查 | 专用 iPhone 17 模拟器、iOS 26.3、未登录页面          | 公开登录页中文、空框聚焦、键盘与可见布局   | 登录提交、登录后流程、实体手机体验     |

当前开发分支为 `feat/project-workbench-prototype`，新增 Demo 尚未提交；Git 分支或原型旧提交不能唯一标识本轮未提交实现。后端启动时计算 `buildHash`，覆盖 `server.mjs` 与 `fixtures.mjs` 内容，各次修复与验收分别关联实际哈希。

历史后端 `ff98f7b0b6b18d209afb920aaaea454390fc8e855e733d3c9b24ddf649915ff8` 已通过 VM 的 10 组 API 检查、100 次受控竞态和完整 600.28 秒场景验收。持续发送确认 p95 为 435.98ms，满足既定 500ms 门槛；此前 501.85ms 的失败保留原始证据。该性能结果不能移用于当前 CPA 接入版本。历史前端 `agentDemo-BNpfdmZI.js` / `agentDemo-31z-RJyc.css` 已完成公开登录页的 Chrome 与模拟器 Safari 复验。

该历史修复版本的主服务哈希为 `40105a602fe9a237f0ebe9cb16183850d91ca0ff47a920f7914de9cbf2fee088`，前端为 `agentDemo-CaIQM1G4.js` / `agentDemo-CnfUa5uR.css`。后端保留上述真实桥接三轮证据；前端已追加本节前述过滤规则及 ZeroTier 登录验证，没有重跑 ff98 的 100 次竞态/600 秒持续负载或旧前端完整交互套件。登录后软键盘交互、实体手机和用户的实际体验评价仍未完成。

测试使用当前工作区脚本和 Node 内置 `fetch`、HTTP、SQLite，无浏览器状态注入；服务端业务测试均使用实际 HTTP。测试账号为独立演示账号，与 VM 系统账号无关。证据文件未包含系统口令、会话 Cookie 或模型凭据。

VM 运行环境由部署过程确认使用 Node.js `v24.22.0`、用户级 systemd 服务；具体校验、服务配置与发布文件版本以部署记录为准。下方历史场景性能表中的客户端是本机测试进程，经 LAN 请求 VM，未人为添加延迟或丢包；上方 Grok 真实验收则在 VM 内回环执行，两者不能混合统计。

## 已完成的初轮检查

以下结果均来自实际退出码和 JSON 记录，不把测试脚本中尚未运行的断言列为通过。

| 范围                   | 结果                                                              | 证据                                                                                 |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 本机 HTTP API          | 10 组通过                                                         | [api.json](../.test-artifacts/agent-demo-api/api.json)                               |
| VM LAN HTTP API        | 10 组通过                                                         | [VM api.json](../.test-artifacts/agent-demo-vm-api/api.json)                         |
| 同一轮次/幂等/停止边界 | 25 轮 × 4 类 = 100 次受控竞态通过                                 | 上述两份 API 记录中的 `raceCases` 和对应检查                                         |
| 五会话并发             | 五个独立活动轮次，30 次引导确认通过                               | API 记录中的“五会话并发独立运行与 API 确认延迟”                                      |
| 崩溃恢复               | 2 次 SIGKILL 重启、3 组检查通过                                   | [restart.json](../.test-artifacts/agent-demo-api/restart.json)                       |
| 慢请求与删除回放       | 4 组通过                                                          | [adversarial.json](../.test-artifacts/agent-demo-api/adversarial.json)               |
| 大型 SSE 回放          | 20,869,004 字节、160 事件通过；包含慢读、提前断开与回放中新增事件 | [sse-load.json](../.test-artifacts/agent-demo-api/sse-load.json)                     |
| Bridge 协议            | 8 组通过，包含延迟停止终态场景与控制请求 ID 校验                  | [bridge-protocol.json](../.test-artifacts/agent-demo-api/bridge-protocol.json)       |
| VM 持续运行            | 首轮 120.52 秒连接失败；保留失败证据，最终修复结果见下文          | [soak-failed-120s.json](../.test-artifacts/agent-demo-vm-soak/soak-failed-120s.json) |

API 的 10 组包括：

1. 登录拒绝、HttpOnly/SameSite Cookie、缺失/错误 CSRF。
2. 项目成员、私有/共享会话、资料下载、未发送附件、已发布附件、个人草稿及跨会话附件权限。
3. 重复发送和引导只执行一次；同请求标识不同输入返回冲突；引导保留原轮次及部分输出；终态后明确拒绝引导。
4. 队列编辑、删除、重排、停止后暂停、显式恢复及 FIFO；非队列更新不误拒编辑，队列自身的过期版本不能覆盖新内容。
5. 澄清保持原轮次、重复回答只有一条用户答复、等待澄清期间队列不抢跑。
6. 失败保存部分输出，继续沿用原输入/附件，重复继续不创建两个轮次。
7. SSE 私有/共享过滤、断线后的持久事件回放、序号顺序和唯一性。
8. 100 次并发与边界检查：重复发送、重复排队、重复引导、停止与引导同时到达。
9. 五会话并发及 30 次 HTTP 引导确认延迟。
10. 草稿旧版本拒绝覆盖、会话版本递增、运行中删除守卫。

重启测试只终止自己创建的临时服务。验证部分输出、附件、草稿、幂等记录仍在；运行状态变成中断而非假运行；队列保留并暂停；SSE 序号递增；第二次重启不重复恢复；用户可显式继续。

定向竞态测试通过延迟 HTTP 请求体构造先到后执行的请求，验证旧草稿不能覆盖新保存、会话删除后的迟到修改被拒绝。另验证删除事件在断线后可回放且权限不泄露，`Last-Event-ID` 生效，退出登录立即关闭原会话 SSE。

## 实测延迟

每项单位为毫秒。下表区分初轮结果和带部署哈希的后续检查。

| 环境与操作                                           | 样本 |    p50 |    p95 | 最大值 |
| ---------------------------------------------------- | ---: | -----: | -----: | -----: |
| 本机 loopback，五会话中的 HTTP 引导确认              |   30 |   3.22 |   4.39 |   4.92 |
| VM LAN，五会话中的 HTTP 引导确认                     |   30 |  14.20 |  23.27 |  23.33 |
| VM LAN，全部 API 请求（含负向验证、轮询和清理）      |  597 |  10.89 |  23.66 | 310.97 |
| VM LAN，a1d47 版本 API 的 HTTP 引导确认              |   30 |  13.67 |  18.99 |  20.43 |
| VM LAN，a1d47 版本全部 API 请求                      |  605 |  10.46 |  18.76 | 120.12 |
| VM LAN，a1d47 版本 601.65 秒持续运行中的发送确认     |  305 | 131.68 | 501.85 | 723.83 |
| VM LAN，历史 ff98 版本 API 的 HTTP 引导确认          |   30 |  11.93 |  17.44 |  20.11 |
| VM LAN，历史 ff98 版本全部 API 请求                  |  605 |   9.78 |  16.83 |  44.57 |
| VM LAN，历史 ff98 版本 600.28 秒持续运行中的发送确认 |  300 | 122.72 | 435.98 | 577.18 |

确认延迟测量从客户端发出 HTTP 请求到读取完整响应，服务端执行器为 `scenario`。API 原始请求计时到响应文本读取结束；持续运行的发送计时还包括客户端 JSON 解析与返回值校验，此定义在各次持续验收中保持不变。ff98 历史版本的短会话 API 与长历史持续运行均满足 LAN API 接收确认 p95 ≤ 500ms 的工程目标；最大值仍可超过 500ms。全部 API 请求包含负向验证、轮询和清理，仅用于总体观察，不能当作纯发送延迟。这些数据不等于模型生成或页面渲染速度；不能用短会话结果替代长历史负载。

a1d47 版本 API 回归在 UTC `2026-10-20T18:11:34.924Z` 至 `18:11:42.428Z` 完成，[api.json](../.test-artifacts/agent-demo-vm-final-api/api.json) 记录 10 组通过、100 次受控竞态，以及开始/结束一致的后端哈希、Node `v24.22.0` 和零活动测试轮次。该轮增加了同请求标识不同输入冲突、非队列更新不误拒队列编辑、真正队列变更后拒绝旧版本的断言。

历史 ff98 版本 API 回归在 UTC `2026-10-20T18:28:34.413Z` 至 `18:28:41.479Z` 完成，[最终 api.json](../.test-artifacts/agent-demo-emission-final-api/api.json) 的 10 组与 100 次竞态全部通过。开始/结束健康检查的哈希一致，`active=0`，运行时为 Node `v24.22.0`；客户端 Node `v24.19.0`。

## 修复后取得的针对性证据

| 发现                                       | 修复方向                                       | 验证                                             |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| 中文 UTF-8 字符被网络 chunk 拆开时可能乱码 | 流式 TextDecoder                               | 将“设备”首字节拆到不同 chunk，正文仍完全等于原文 |
| live 澄清在幂等检查前发送到 Bridge         | 合并同请求并缓存异步结果                       | 两个并发请求及一次重试，Bridge 仅收到一次回答    |
| 旧停止请求的迟到失败可能覆盖新轮状态       | 以活动轮次身份约束回写                         | 旧轮完成、新轮开始后，迟到失败不改新轮运行态     |
| 运行器断线仍可排队/继续                    | 统一检查运行器可用状态                         | 发送、排队、继续均返回 503，队列和轮次数不变     |
| 结束边界的运行器引导拒绝被变成泛化 500     | 映射为明确的 409 业务错误                      | 不新增轮次、引导消息或队列，不伪造已送达         |
| 草稿读取版本早于完整请求体到达             | 完整解析变更请求后再读取当前状态               | 定向慢请求返回冲突，保留新草稿                   |
| 删除后的事件因会话已移除无法回放           | 为删除事件保留受限授权信息，出站不暴露内部字段 | 有权用户收回放，其他项目用户收不到               |

上游事件流意外结束也已验证：部分文字保留，状态明确失败，队列暂停且可继续。停止请求失败已验证：显示错误并恢复真实运行态，不把失败包装成已停止。

“Bridge 已接受停止请求”与“运行器真正中断”是不同时间点。新增测试已通过：HTTP 200 接收回执之后延迟 500ms 才发送 SSE `interrupted`，期间主服务保持 `stopping`，丢弃晚到正文并暂停队列；终态到达后才变成中断。控制动作的测试替身还要求 `requestId`，缺失时拒绝，用于贴合实际桥接契约。

## Codex 桥接协议与真实 CLI 初始化

既有 [Codex 桥接注入检查](../.test-artifacts/agent-demo-api/codex-bridge.json) 由 [agent-demo-codex-bridge.mjs](../test/agent-demo-codex-bridge.mjs) 完成：27 项断言通过，`runnerProcesses=0`、`realModelCalls=0`。它使用注入运行器验证桥接的鉴权、控制去重、授权资料/附件、澄清、报告和 SSE 处理；它与主服务连接 HTTP Bridge 替身的 8 组检查是不同测试，也没有证明真实 CLI 接受配置。

新增 [真实 CLI 启动报告](../.test-artifacts/agent-demo-api/codex-startup.json) 来自 [agent-demo-codex-startup.mjs](../test/agent-demo-codex-startup.mjs)，测试时间 UTC `2026-10-20T18:38:14.222Z`，实际版本为 `codex-cli 0.159.2`，6 组通过，子进程正常退出。检查在现有 macOS Seatbelt 工具沙箱中执行，网络保持禁用、无提权；启动前为子进程创建空白临时 `HOME`、`CODEX_HOME` 和 cwd，从零构造环境，不继承 API key 或个人配置。探针使用临时凭据存储及无鉴权提供方，地址只指向不可达回环端口；这不是可用模型配置。临时目录已在检查后删除。

6 组实际检查为：

1. `initialize` / `initialized` 握手成功。
2. `permissionProfile/list` 能列出命名权限配置 `agent_demo`。
3. `config/read` 确认指定工具开关、根目录拒绝与网络禁用配置被读取。
4. 带六个业务 `dynamicTools` 的临时 `thread/start` 被接受。
5. 返回 `agent_demo / never / readOnly / networkAccess:false`，线程没有轮次、指令来源文件或工作区根目录。
6. 请求记录中没有 `account/read`、`turn/start` 或任何业务工具执行请求，模型调用为零，未请求个人凭据。

这补齐了真实 CLI 对 `--stdio --strict-config`、现有配置及动态工具注册的启动兼容证据。配置被接受与运行时工具隔离是不同结论：该启动检查没有执行工具或模型轮次，不能证明实际文件/网络访问会被阻断，也不能证明模型权限、真实同轮引导、停止、继续或并发行为。后续真实执行证据另见本文 Grok CPA 三轮验收；前后端历史场景版本与全部失败证据不受本机启动检查影响。

## 持续运行检查

脚本 [agent-demo-soak.mjs](../test/agent-demo-soak.mjs) 默认持续 600 秒，可用 `AGENT_DEMO_SOAK_SECONDS=1800` 改为 30 分钟。它按实际墙钟运行，每 10 秒在五会话同时发起短任务，每四轮检查停止/队列暂停/恢复，每五轮主动断开 SSE 250ms 再按游标重连，每轮检查服务健康、消息归属、事件唯一性，并输出进度。这是固定频率的并行交互稳定性测试，负载间有空闲时间。

首轮在 120.52 秒失败：12 个完整循环结束后，下一轮重连附近出现 `TypeError: fetch failed`，随后的清理请求也连接失败；65 次发送确认的 p95 为 294.00ms，925 个已观察事件没有重复。随后独立健康检查恢复 HTTP 200。[部署端日志](../.test-artifacts/agent-demo-vm-soak/first-failure-journal.txt)已定位为 SSE 回放期间的 `ERR_STREAM_WRITE_AFTER_END`：缓冲超过限制后响应被关闭，回放循环仍尝试写入，导致进程退出并由 systemd 重启。它不是稳定性通过，失败证据单独保留，不被后续复跑覆盖。上轮留下的五个测试会话已按创建时间与随机标题精确清理，记录在 [cleanup.json](../.test-artifacts/agent-demo-vm-soak/first-failure-cleanup.json)。

修复后新增独立回放回归：12 轮长消息形成 486,166 字节会话快照，实际回放 20,869,004 字节、160 个事件；主动提前断开、每次读取延迟 10ms、回放期间再追加四个事件均通过。序号追到 161，没有重复或解析错误，慢读期间健康检查为 1.17ms，进程保持存活。该证据记录后端 `buildHash=a3400212025a73b89a2255fc749f8e2028bd2a08e3a9bc497854572762ed8a0b`，但仍不能替代 VM 上完整 600 秒复验。

第二轮也未完成：[保留的进度证据](../.test-artifacts/agent-demo-vm-soak/soak-second-failure-progress.json)显示主动重连后 SSE 事件累计停在 150，而 HTTP 仍能完成新轮次，随后连接报 `TypeError: terminated`。部署日志显示服务进程未重启。这暴露出实时流背压与验收覆盖的双重问题：旧脚本虽检查收到的事件不重复，却没有要求每轮终态必须经 SSE 到达，且异常关闭时清理断言阻止了最终报告写入。该次不计通过。

验收已加强：每轮必须在 5 秒内收到全部五会话的终态快照及足够新的 `eventSeq`；HTTP 轮询成功不能替代事件流成功。异常断线/重连单独记录，保留接收字节数、最后事件时间和底层原因；最终报告与清理不再被关闭错误跳过。定向负载测试另加入五会话长历史、实时慢读、中途重连与逐会话终态验证，后端统一回放和实时流的游标推送与背压处理。之后重新开始完整持续测试。

统一推送后的本机定向测试通过：五会话四轮实时慢读产生 23,558,740 字节、260 个事件，包含一次重连，全部二十个终态快照收到。但同一后端哈希 `f9a7b7f5ce7670064126dfaaaa23fc05b3c9ad67f038704882e7fe8ca23f0445` 的 VM 第三轮在 25.83 秒被加强验收拒绝：[soak-third-failure.json](../.test-artifacts/agent-demo-vm-soak/soak-third-failure.json)。主动重连后只接收 160,975 字节，事件停在序号 2112，而五个会话 HTTP 终态已到 2149–2157；连接尚未关闭，却五秒不再更新。该结果说明本机负载通过不能替代实际部署链路，当时仍未完成持续验收。

随后增加缓冲状态复核：等待 `drain` 前后检查是否已排空，等待中每 25ms 复核响应和 socket 的缓冲，不把已经排空的连接一直挂起；真正无法排空的慢连接仍有超时边界。[35 秒 VM 定向回归](../.test-artifacts/agent-demo-vm-reconnect/soak.json)通过四轮、305 个事件及一次重连，五会话终态逐轮核实；20 次发送 p95 为 48.54ms。[跟踪日志](../.test-artifacts/agent-demo-vm-reconnect/trace-journal.txt)记录八次等待，其中七次正常 `drained`，一次在 `needDrain=true`、两层缓冲长度均为零时由复核恢复。证据支持“已空缓冲仍等待 drain 导致停滞”的状态问题，不据此泛称 Node 缺陷。修复哈希为 `a1d47ea124b21a621fee82d3a2a249af8d71152ef6688e272e10e82b31e2551b`。

第四轮完成整段运行，但综合门槛未通过：[soak-fourth-latency-failure.json](../.test-artifacts/agent-demo-vm-soak/soak-fourth-latency-failure.json)。UTC `2026-10-20T18:01:05.418Z` 至 `18:11:07.101Z`，实际 601.65 秒、61 轮、305 个主动发送轮次；加上停止后恢复的排队任务，共 380 个 Agent 轮次，每会话积累 76 轮历史。共收到 4,632 个持久事件，其中 2,208 个正文增量；12 次计划重连，零意外断线/重连，零重复事件，所有轮次的五会话终态均由 SSE 确认，逐轮后端哈希保持一致，测试会话清理成功。

该轮 305 次发送的 p50 为 131.68ms、p95 为 501.85ms、最大 723.83ms，p95 超过既定 500ms 门槛，脚本返回失败。不能因为只超出约 1.85ms 就四舍五入标为通过，也不能用随后短会话 API 的 18.99ms 引导 p95 替代。进一步优化聚焦事件持久化中对完整会话的重复复制、编码与写入；修改后仍须重新完成整段测试，不改变阈值。

[长历史大小记录](../.test-artifacts/agent-demo-deployment/long-history-size.json) 对上述五个测试会话的末次接受回执做只读统计：每会话 76 个轮次、152 条消息，完整会话 JSON 为 406,276–408,125 字节，其中内部上下文数组 148,809 字节。数字是 UTF-8 JSON 大小，不是网络包字节。当前完整快照仍随历史增长；正式版需要拆分公开会话数据和内部执行快照，再补历史分页与事件检查点。

事件写入优化版本 `ff98f7b0b6b18d209afb920aaaea454390fc8e855e733d3c9b24ddf649915ff8` 在同一事务内先分配事件序号，再同步编码最终事件，去掉完整快照的首次写入与重复深拷贝；SQLite 持久性级别、事件内容与性能门槛不变。该版本的独立 [重启回归](../.test-artifacts/agent-demo-emission-regression/restart.json) 3 组、[定向竞态](../.test-artifacts/agent-demo-emission-regression/adversarial.json) 4 组、[受控 Bridge](../.test-artifacts/agent-demo-emission-regression/bridge-protocol.json) 8 组，以及 [20.9 MB 回放和 23.6 MB 实时流测试](../.test-artifacts/agent-demo-emission-regression/sse-load.json) 均通过。

[VM 微基准](../.test-artifacts/agent-demo-api/emit-microbench-vm.json) 在隔离数据库中比较相同的 `emit+save` 路径，每种大小先预热 10 对、再交替运行 100 次。约 306KB 会话的 p50/p95 从 8.13/19.30ms 变为 5.01/12.83ms；约 1.08MB 会话从 29.15/42.04ms 变为 19.92/35.20ms，大会话最大值则由 44.55ms 变为 54.05ms。最终事件和会话内容逐字一致，逻辑 SQL 参数字节减少约三分之一；这不等于物理磁盘写量下降，也不能据此推算整体 HTTP p95。

**ff98 历史版本的完整持续验收通过。** [soak.json](../.test-artifacts/agent-demo-emission-soak/soak.json) 记录 UTC `2026-10-20T18:18:13.498Z` 至 `18:28:13.789Z`，实际 600.28 秒、60 轮循环、300 次主动发送及 75 个恢复后的排队任务，合计 375 个 Agent 轮次。每轮五会话的最终状态均由 SSE 确认；共收到 4,575 个事件和 2,175 个正文增量，12 次计划重连、零意外重连、零重复、零失败，测试会话清理成功。逐轮后端哈希均为 ff98。300 次发送确认 p50/p95/最大值为 122.72/435.98/577.18ms，满足原定 p95 ≤ 500ms 门槛，未降低负载或修改计时定义。该完整负载尚未在当前 40105a CPA 接入版重跑。

对应时段的 [服务日志](../.test-artifacts/agent-demo-deployment/soak-final-journal.txt) 与 [摘要](../.test-artifacts/agent-demo-deployment/soak-final-journal-summary.json) 共 4,250 行，未检出 `write-after-end`、`drainTimeout` 或进程失败标记；记录四次空缓冲复核恢复。服务 PID、重启计数和内存快照另由最终部署清单保存。

最终以 `soak.json` 中 `status`、`elapsedSeconds`、轮数、确认延迟、重复事件数和失败列表为准。修复后须重新完成整段持续测试，不能把多个中断片段拼成 600 秒通过。测试完成后仅清理自己创建的会话，不清理其他用户演示。

## 浏览器与交互证据

[完整浏览器报告](../.test-artifacts/prototype-v2/agent-demo/report.json) 在 UTC `2026-10-20T18:20:23.281Z` 完成，绑定前端 `agentDemo-C6erRTre.js`、后端 ff98；16 项场景检查通过，真实模型调用为零。覆盖登录、中文输入法、发送与澄清、引导/队列/停止/继续、迟到回执、草稿加载失败重试、附件与资料预览下载、阅读位置、断线恢复及账号切换权限。390/768/1280/1920 尺寸、长代码/表格和减少动态效果有截图；桌面和手机布局、运行中队列及资料预览已作实际图像检查。

后续补验版本为 `agentDemo-KZjpH3dt.js` / `agentDemo-H4mF1F69.css`。[补充报告](../.test-artifacts/prototype-v2/agent-demo-ui-supplement/report.json) 于 UTC `2026-10-20T18:28:11.993Z` 完成，后端仍为 ff98，9 项通过：同名报告展示不同轮次与秒级时间、五条 Tab/Escape/关闭后的焦点路径、手机结果下载链接 40×40、降低透明效果与强制系统颜色。四张补充截图已查看。之前发现的焦点问题保留 [失败报告](../.test-artifacts/prototype-v2/agent-demo-ui-supplement/report-focus-failure-Dxf79ZJK.json)。该版小修只做相关补验，不将前端 C6erRTre 的完整 16 项冒充 KZjpH3dt 的全量重跑，也不将两份报告归到之后的字号修复版本。

浏览器延迟来自完整 16 项报告，单位毫秒：

| 测量                                         | 样本 |   p50 |    p95 | 最大值 |
| -------------------------------------------- | ---: | ----: | -----: | -----: |
| 常规 HTTP 请求                               |   53 | 12.30 |  35.10 |  60.40 |
| 收到事件至处理批次后的动画帧回调             |   82 | 25.60 |  32.80 |  55.50 |
| 定向输入：原生 insertText 后下一帧文本值正确 |   20 | 10.40 |  21.20 |  21.20 |
| 泛化输入事件至首次 DOM 变动                  |   47 |  0.90 | 342.10 | 346.70 |
| 泛化点击事件至首次 DOM 变动                  |   35 |  1.60 | 127.20 | 293.40 |

定向输入样本满足 100ms 的反馈目标。泛化 DOM 采样未证明变化由对应操作引起，不能用来断言全部界面动作达到 100ms；较高值仍如实保留。事件至动画帧是渲染附近的近似，不是硬件显示时间。上述测试使用桌面 Chrome 的尺寸、媒体和输入模拟，未验证真实手机软键盘、系统辅助技术或全部色彩对比度，亦不证明用户主观认为流畅。

新增 [定向反馈测试脚本](../test/agent-demo-feedback.mjs) 计划对发送、引导、排队、停止、澄清各采样 20 次，共 100 次，通过真实 DOM 点击关联对应控件的等待/禁用信号或成功结果，再观察下一动画帧。脚本仅完成编写与静态检查，**100 个样本全部尚未执行**，没有新的延迟分布或通过结果。下述指定演示账号登录的自动审批拒绝及待回复的明确授权，同样阻止了这项需登录的测量；既有 20 个定向输入样本不能替代这五类操作。

## 公开登录页的字体、软键盘与触控修复

[iOS 报告](../.test-artifacts/agent-demo-ios-keyboard/report.json) 记录 UTC `2026-10-20T18:49:46.823Z` 的专用 iPhone 17 / iOS 26.3 模拟器 Safari 检查，状态为 `partial-blocked`，没有登录、没有模型调用，后端仍为 ff98。它使用平台软件键盘，不是桌面 viewport 缩放，也不是实体 iPhone。报告附五张截图及 [静态字体对照页](../.test-artifacts/agent-demo-ios-keyboard/font-control.html)。

旧版 `KZjpH3dt / H4mF1F69` 的登录输入为 12px：聚焦密码框后 Safari 明显自动放大，收起键盘仍有残留放大。登录输入局部改为 16px 后，以 `agentDemo-kQlUvFHs.js` / `agentDemo-Chc_E9lu.css` 在同一 Safari 新导航复验，聚焦保持正常宽度，收键盘回到完整登录卡片。证据见 [修复前聚焦](../.test-artifacts/agent-demo-ios-keyboard/login-password-keyboard.png)、[修复前收键盘](../.test-artifacts/agent-demo-ios-keyboard/login-after-keyboard-dismiss.png)、[16px 聚焦](../.test-artifacts/agent-demo-ios-keyboard/login-password-keyboard-after-16px.png) 和 [16px 收键盘](../.test-artifacts/agent-demo-ios-keyboard/login-after-keyboard-dismiss-16px.png)。这只证明该版本的登录输入聚焦缩放修复。

首轮还发现键盘打开时登录按钮部分被 Safari 输入附件栏遮挡，收起键盘后完整可达；同时出现 `-apple-system` 中文缺字，而默认字体、Apple 中文官网和原生 Safari 中文正常，见 [字体对照截图](../.test-artifacts/agent-demo-ios-keyboard/font-control-default-vs-apple-system.png)。这是当时该新模拟器的局部观察，不能外推真实 iPhone；首轮因文案宽高受到影响，没有将整页视觉判为通过。字体与遮挡问题随后实际修复并复验，见下文，旧报告不覆盖。

自动审批两次拒绝输入指定演示账号密码：首次认为可信用户消息没有授权使用该具体账号；补充公开演示凭据的源码证据后重试，仍要求用户明确授权。相关授权问题已提出、尚待回复，随后没有继续输入或登录，也没有绕过审批执行反馈采样。检查后只删除本次创建的临时设备，报告记录 UTC `2026-10-20T18:50:14.167Z` 已核实设备不存在（`deleted-and-verified-absent`）。

后续在第二台独立 iPhone 17 / iOS 26.3 模拟器中做 [字体矩阵检查](../.test-artifacts/agent-demo-ios-font/report.json)：相同文本与 16px 字号下，默认字体、`PingFang SC`、`sans-serif` 中文正常，`system-ui` 和 `-apple-system` 出现缺字方框，见 [矩阵截图](../.test-artifacts/agent-demo-ios-font/font-matrix.png)。修复仅作用于 Demo 的 `body.ad-document`，将 `PingFang SC` 放到首位，并让挂载到 body 的弹层继承；没有修改全项目字体或等宽字体。登录页最小高度使用已有 `visualViewport` 高度变量，保留自然滚动，解决软件键盘下按钮遮挡。

该轮修复部署为 `agentDemo-BNpfdmZI.js` / `agentDemo-31z-RJyc.css`，当时后端为 ff98。宽度 ≤767px 时，主页面、登录页、历史/上下文 Sheet 及新建/编辑 Dialog 的 Input、Textarea、NativeSelect 为 16px；移动 Input、NativeSelect 和登录按钮至少 40px。格式、类型及构建检查通过。扩展到登录后控件和弹层的修改仍只有静态同因检查，不能据此声称其运行时布局通过。

[最终 iOS 跟进报告](../.test-artifacts/agent-demo-ios-font/font-followup-report.json) 于 UTC `2026-10-20T19:06:15.945059Z` 完成，绑定 BNpfdmZI / 31z-RJyc：公开登录页中文完整；聚焦空密码框并展开平台软件键盘时没有自动放大，输入框和完整登录按钮均位于 Safari 地址/附件栏上方；收键盘后登录卡片完整恢复，无残留缩放或裁切。见 [最终键盘展开](../.test-artifacts/agent-demo-ios-font/login-final-keyboard.png) 和 [最终收键盘](../.test-artifacts/agent-demo-ios-font/login-final-keyboard-dismissed.png)。这次没有输入密码，登录按钮保持禁用，只证明其可见与无遮挡，没有提交登录或调用模型。报告还记录第二台临时设备已关闭、删除，并以只读设备清单核实不存在；第一轮的 `partial-blocked`、两次审批拒绝及失败截图全部保留。

[BNpfdmZI Chrome 公开页报告](../.test-artifacts/agent-demo-public-login/before-cpa-BNpfdmZI/report.json) 于 UTC `2026-10-20T19:04:15.878Z` 完成，绑定 BNpfdmZI / 31z-RJyc。在全新浏览器配置下只读取公开页，390×844 与 1280×900 两尺寸通过，没有输入凭据、提交登录或读取 Cookie。移动输入字体为 16px，两个输入框及登录按钮 DOM 高度均为 40px，标题实际使用 `PingFang SC`；无运行时错误，保留预期的未登录 401 警告。截图为 [390×844](../.test-artifacts/agent-demo-public-login/before-cpa-BNpfdmZI/login-390x844.png) 与 [1280×900](../.test-artifacts/agent-demo-public-login/before-cpa-BNpfdmZI/login-1280x900.png)，旧版 36px 尺寸记录保留在 [前次报告](../.test-artifacts/agent-demo-public-login/before-Dwju7zjN/report.json)。40px 的精确尺寸来自 Chrome DOM，不能从 Safari 截图反推 CSS 像素。

此前 8L7Ruwid 版的 [Chrome 公开页报告](../.test-artifacts/agent-demo-public-login/report.json) 于 UTC `2026-10-20T23:28:33.277Z` 完成，仍为 390×844、1280×900 两尺寸的未登录检查；新增当前模型/运行器显示位于登录后界面，本次没有实际查看。该版截图为 [390×844](../.test-artifacts/agent-demo-public-login/login-390x844.png) 和 [1280×900](../.test-artifacts/agent-demo-public-login/login-1280x900.png)。没有在当前版本重跑 iOS Safari。

Chrome 完整 16 项和补充 9 项仍分别属于 C6erRTre 和 KZjpH3dt，首轮登录字号局部复验仍属于 kQlUvFHs / Chc_E9lu，Safari 字体/键盘修复复验属于 BNpfdmZI，均保留各自版本范围，没有作为当前 CaIQM1G4 的全量复验。登录后的发送、引导、停止、阅读、抽屉、软键盘及真实手机硬件/辅助技术仍未补验。

## 剩余边界与完成情况

CPA `grok-4.6` 已选定、配置并完成真实桥接三轮，模型来源不再是阻塞项；流式、工具读取、报告、澄清、等待期间同轮引导和客户端可见停止均有实际证据。还需补齐主服务与 WebUI 的真实模型完整流程、服务端排队与 continue、底层文件/命令/网络边界、模型长时间/并发性能，以及图片/PDF 等附件读取。指定演示账号登录授权仍是另一个独立待回复项，影响登录后软键盘检查和定向反馈采样。

| 必须补齐的项                 | 当前状态                                                 | 应提供的证据                                                                       |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 真实模型三个桥接场景         | 资料/报告、澄清引导、流式停止三个 run 通过               | 真实输入、工具、事件、双标记与报告已保存；不替代 WebUI 的三个完整业务流程          |
| 真实 CLI 启动与配置兼容      | 0.159.2 的 6 组检查通过                                  | 无鉴权、零模型调用的初始化与配置回读；不替代下述运行时验证                         |
| 真实运行器的只读隔离         | 未完成                                                   | 文件、命令、网络/写操作边界实测；不能仅引用提示词或配置                            |
| 真实模型的停止、继续、引导   | 桥接可见停止、等待澄清期间同轮引导通过；continue 未验    | 仍需主服务/UI 串联、实际继续上下文与附件、其他执行时刻引导，以及上游原始停止状态   |
| 附件完整能力                 | 合成文本附件实际读取并写入报告；其他格式未完成           | 图片/文档仍需实际读取；当前报告是桥接 artifact 事件，不代表主服务保存或下载已验证  |
| 桌面/平板/手机视觉与交互     | 旧版 16+9 项；当前 CaIQM1G4 过滤规则及 ZeroTier 登录通过 | BNpfdmZI Safari 证据保留原版；当前登录后控件、模型显示与弹层尚无全量运行时复验     |
| 手机软键盘                   | BNpfdmZI 模拟器公开登录页空框聚焦与可见布局通过          | 未输入密码或提交登录；当前版登录后输入/发送/停止、阅读和抽屉仍需实测，实体手机另验 |
| 输入、滚动与事件到显示延迟   | 既有 UI 样本与三轮真实桥接时延；100 个反馈样本未执行     | 五类操作反馈、物理显示/软键盘及稳定模型延迟分布仍未证明；不能从三个样本外推 p95    |
| 完整持续运行结果             | ff98 历史版 600.28 秒通过                                | 完整场景负载尚未在当前 40105a 重跑；真实模型五会话并发/持续测试未验，此前失败保留  |
| 最终部署版本关联             | 后端/前端哈希分别记录                                    | 以最终发布清单和证据包索引对应文件                                                 |
| 用户认为“非常流畅”的实际体验 | 尚未获得                                                 | 可访问 demo、完整流程演示及用户实际评价；自动化不代替主观认可                      |

## 复验命令

Node.js 24+。命令在仓库根目录执行，服务必须已启动；不需要执行真实模型。

```sh
node test/agent-demo-api.mjs
node test/agent-demo-restart.mjs
node test/agent-demo-bridge-protocol.mjs
node test/agent-demo-sse-load.mjs
AGENT_DEMO_ISOLATED=1 node test/agent-demo-adversarial.mjs

AGENT_DEMO_URL=http://192.168.31.157:8787 \
AGENT_DEMO_EVIDENCE_DIR=.test-artifacts/agent-demo-emission-final-api \
node test/agent-demo-api.mjs

AGENT_DEMO_URL=http://192.168.31.157:8787 \
AGENT_DEMO_EVIDENCE_DIR=.test-artifacts/agent-demo-emission-soak \
AGENT_DEMO_SOAK_SECONDS=600 \
node test/agent-demo-soak.mjs
```

证据目录由 `.gitignore` 忽略，源代码提交不会携带这些本机文件。最终文件关联见 [部署清单](../.test-artifacts/agent-demo-deployment/deployment.json)、[远端文件清单](../.test-artifacts/agent-demo-deployment/remote-manifest.json) 和 [证据包索引](../.test-artifacts/agent-demo-delivery/evidence-index.json)，实际交付归档为 [autoops-agent-demo.zip](../.test-artifacts/agent-demo-delivery/autoops-agent-demo.zip)。应同时保留归档与索引，避免只交付失效的本机链接。
