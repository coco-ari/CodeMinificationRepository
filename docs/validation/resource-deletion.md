# 创建与删除闭环验证

日期：2026-10-29。工作树：`worktrees/deployment-validation`，分支：`feat/workspace-deployment-validation`。基线：`3182b024`。

## 原问题与修改

原有账号、助手、凭证、部署服务/位置、更新计划、成员及电脑登记缺少直接删除入口；项目/环境删除被历史引用阻止；部分删除仅隐藏行，留下旧版本、密文、会话正文事件或磁盘原件。按[当前设计](../../examples/resource-deletion-design.md)增加确认入口与模块公开清理方法，父对象删除协调各 owner；原生会话沿既有持久队列最终物理清理。

前后流程：此前删项目需要逐个处理引用，部分对象只有停用、撤回或无法继续；现在“打开删除 → 核对范围 → 确认”后系统处理关联。取消不提交；进行中的远端部署返回具体等待原因，结束后可继续同一请求。删除账号、计划等同样先确认，列表只在实际成功后刷新。正常路径不要求用户手工清理内部收据。

## 验证状态

使用隔离 SQLite、临时文件和浏览器组件交互，不操作真实测试站数据。最终修复后结果如下：

| 范围 | 结果与证据入口 |
| --- | --- |
| 模块生命周期 | 286 项通过（主回归 285 项，账号并发删除补充后该模块 20 项复验通过，新增 1 项）：`test/deployment.test.mjs`、`test/t3-{deployments,project-directory,project-deletion,project-repositories,workspace-current,workspace-management,workspace-authoring,runtime-accounts,assistants,workspace-credentials,skill-library,workspace-updates}.test.mjs`，以及 `agent-demo/t3-adapters/{customer-registry.test.mjs,environment-mcp/index.test.mjs}` |
| 服务端 HTTP / 删除队列 | 53 项通过：`src/autoops/http/{accounts,projectDirectory}.test.ts`、`src/autoops/projects.deletion.test.ts`、`src/orchestration-v2/{DeletedDataCleanup,ThreadDeletion,EffectWorker}.test.ts`（相对原生 server） |
| 实际原生清理工作器 | `runtimeLayer.test.ts` 的会话/项目删除与并发更新 3 项通过，其他 99 项未选取；排空持久队列后检查会话投影、正文事件已物理清除，相关自动任务已删除，其他任务保留 |
| 前端逻辑 | 105 项通过：`providedAssistants`、`projectAssistants`、`accounts`、`projectDirectory`、`workspaceAuthoring`、`CustomerDevicesSettings`、`environmentMcpApi` 的 unit 测试 |
| 浏览器交互 | 98 项通过：`AccountManagementPage`、`AssistantManagementPage`、`ProjectRemovalDialog`、`WorkspaceUpdateDialog`、`UnifiedAssistant`、`ProjectCredentials`、`CustomerDevicesIsolation` 的 browser 测试 |
| 类型与构建 | 根 UI、adapter、原生 web/server 类型检查通过；Vite 前端与原生服务端打包通过。构建仅有既有大包提示，不影响成功结果 |
| 边界与差分 | 运行模块 308 个源文件扫描，0 项错误；`git diff --check` 通过 |

验证覆盖取消不写入、确认后刷新、权限/修订拒绝、清理失败重试、父对象级联、原请求不误删重建对象、并发删除仍能核对各自最小结果、迟到测试结果不重建已删配置，以及其他对象不受影响。沿用既有代表性窄屏、长标题和键盘交互用例；没有把本批入口的组件测试冒称全部页面、所有主题尺寸或真实外部设备验收。

复验过程修复了格式整理造成的分支缺失、环境删除 SQL 参数及新测试定位问题；以上均为修复后的结果。最终没有保留失败测试或跳过本批失败用例。

本次用户要求更新文档、提交和推送；未安排部署。此前测试站的浏览器拒绝设置未变更，本批不通过其他工具绕过，未进行真实站点及真实外部设备删除验收。
