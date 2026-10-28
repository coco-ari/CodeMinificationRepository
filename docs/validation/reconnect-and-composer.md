# 对话重连与无助手底栏修复（2026-10-28）

固定代码 `b44b7bf8dccca153017447bb7ca30de26cf0afb7`，基于自适应导航已合入的主工作树。只修改同步授权目录读取与 `ThreadScopeControl` 提示布局，保留原权限裁决、T3 心跳与错误状态，不改变助手配置或数据生命周期。

## 复现、原因与修改

用户在 C6 other 项目看到“正在重新连接对话服务”，无助手提示同时挤压底部控件。旧 worker 未退出或重启，但事件循环日志出现 10–27 秒阻塞，超过原生 15 秒 ping 超时。现场 40 秒 CPU 采样将主要忙时调用定位到 `filterAutoOpsShell → canSeeThread/validateBinding → catalog`：逐线程检查反复读取相同项目、成员和账号目录。不是仅凭一次健康接口快速返回就排除服务端问题。

`withAuthorizationRead` 只在一次同步授权计算内复用 users/projects/agents 三份目录，结束或异常时立即释放；会话过滤与 bootstrap 使用该边界。下一次调用重新读取，撤权、停用和私有会话检查保持。100 个共享会话加 1 个私有会话的真实过滤回归，修复前目录读取 513 次（207/205/101），修复后各 1 次；同时验证下一次请求立即看到成员撤销和账号停用，没有跨请求缓存或延长心跳掩盖阻塞。

底栏沿锁定 T3 的 `ComposerSurface.ContextStrip` 组合：选择控件仍占独立 flex 行，收起测量绑定这行实际宽度；无助手原因和刷新按钮放到下一行，不再参与控件横向空间分配。1280px 与 390px 最小失败用例先复现提示挤压，再验证修复。保留长错误、禁用发送、菜单与可访问名称。

## 自动验证

- access、真实项目目录、环境授权及账号网关 45 项通过；原生 RPC principal 5 项通过。
- 实际 ChatComposer 与 scopeSelection 浏览器回归 21 项通过，含无助手、长提示、桌面和 390px、草稿保留与原菜单行为。
- Web/Server 类型检查、305 文件边界扫描、`git diff --check` 通过。
- 固定 Git 归档的托管 Web、原生 worker、部署 Agent 构建及发行包验证通过；客户 CLI 复用未变化的 0.4.5。Linux 官方原生依赖 2038 文件、21 包核验通过。
- 本机浏览器测试经沙盒外授权启动。首次 Node HTTP 测试因沙盒 listen 限制未运行，授权后原命令通过。仓库嵌套 T3 hook 从根目录解析不到 staged 配置；本批在完成上述检查后仅对本次 commit 禁用该 hook，未修改仓库 hook 设置，也未将 hook 记为通过。不等待 GitHub CI。

## 部署与实站验收

北京时间 21:31 完成测试站原两 unit 切换。前端和后端均为 `t3-reconnect-b44b7bf8`；Web PID 3760892、worker launcher 3760385，运行目录与固定发行一致，active 且 NRestarts=0。HTML SHA256 `0d38255c5c76ffc23c39448d42dd56f54392199cefe2db302a7fbd9cfa001971`，健康 `workerReachable=true`，两个 Web Worker 字节通过。无迁移变化、无测试数据恢复、未改其他服务。

实站通过原 localhost SSH 隧道、现有陶然登录完成：

- 原 C6 other 页面刷新后加载成功，没有重连告警。桌面四项控件 y=454、height=28，原因提示 y=486 单独一行；刷新助手保留未发送草稿。
- 390×600 控件按原响应式规则换行，全部控件结束于 y=437，提示从 y=441 开始，文档 scrollWidth=390。可见范围菜单可打开，Esc 回到消息输入框。随后恢复默认 1280×720。
- C6 other → AutoOps 工作台 → C6 other 正常切换并加载会话列表；AutoOps 目录中的 ok 助手已停用，保留真实禁用原因，没有为验收启用它。清空本次未发送文字，最终页面无浏览器 error 日志。
- 主任务独立实站操作 AutoOps 工作台：展开 demo-travel-map 的 11 项目录，打开 package.json 看到真实 name=travel-map/main=server.js；工作区刷新、整页刷新后原选中文件、内容和登录保持，没有 T3_UNAVAILABLE 提示。完整 AX、截图与操作摘要在 `.deployment/gateway-network-v1/ui-after-ax.txt`、`ui-after.jpg`、`evidence-v1.json`。
- 21:39 的只读现场核对，距新 worker 启动约 8 分钟，事件循环卡顿日志没有新增条目；最后一条为切换前 21:31:27 的 27018ms。临时本地诊断端口 9229 已关闭。

主任务使用同账号、同四个正式 GET 的短样本前后对比：三处工作区目录均 200，条目分别 3/11/10，内容相同；耗时 45/37/45ms → 59/55/54ms，不能声称目录普遍加速。同一 39171 字节、19 会话列表 532ms → 96ms。该样本证明接口与内容保持，并支持会话读取开销减少；不作为长期稳定或所有请求延迟保证。

无效诊断样本另列在主任务 `evidence-v1.json`：自填 Origin/Host 不一致产生的 401、子目录路径末尾斜杠导致空结果、普通 DOM 未穿透 Shadow DOM 的 false 观察，均不作为产品失败或通过证据。正常授权请求及完整 AX 已复核，没有为辅助工具误判改动产品。

本批没有发送模型请求，不新增模型上游可用性、真实弱网/断网或长期并发稳定性结论。短窗口无卡顿不等于所有重连原因消失。原无助手状态仍真实存在，需要项目管理员配置后才能提问。

| 状态 | 结果 |
| --- | --- |
| 代码 | b44b7bf8 已提交并推送 |
| 自动测试 | 45 + 5 项服务回归、21 项浏览器及类型/构建通过 |
| 部署生效 | 前后端 b44b7bf8，版本、健康与实际资源通过 |
| 真实业务验收 | 本批页面、刷新、跨项目、窄屏及正常授权读取通过；长期稳定和模型调用未新测 |

证据：远端 `ROOT=/home/tao/autoops-shared-validation-20261026/reconnect-b44b7bf8` 的 `preflight.json`、`switch.json`、`live-observation.json`；本地忽略目录 `.deployment/reconnect-b44b7bf8-ui` 的截图与日志，`.deployment/gateway-network-v1/real-read-before-v2.json` / `real-read-after-v1.json`。发行清单及回退边界以[当前发行](../../examples/agent-demo-t3-deployment.md#当前验证发行)为准。
