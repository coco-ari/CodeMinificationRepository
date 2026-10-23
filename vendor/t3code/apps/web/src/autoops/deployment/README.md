# 部署前端模块

本目录维护已有服务发布、回退、配置确认及任务日志呈现。公开页面仍为父目录的 DeploymentsPanel，所有数据调用经过父目录 deployments 客户端；不拥有服务端任务状态、不直接调用工作区文件接口。

- DeploymentsPanel：项目/环境/服务选择、概览刷新、待核对请求与幂等提交协调。未知提交结果只重试原 requestId，页面错误重试不会自动发送。
- DeploymentDialogs：发布按现行配置确认，回退按所选历史配置确认；缺少历史快照时不能提交。并发检查仍使用现行 configKey，只向协调组件提交 DTO。
- DeploymentLogs：单个固定项目/服务/任务的增量游标、请求取消、阅读位置、阶段及失败恢复详情。切换身份重新建立本地日志状态。
- ConfigurationDetails：复用 T3 设置分组展示目标与站点、构建、验证与恢复，目标标识按需展开。
- DeploymentControls / deploymentPresentation：当前实际共用的原生控件组合与格式化，无业务请求和授权规则。

依赖方向为页面协调到本目录和 deployments/workspaces 公共 DTO；子组件不导入页面内部状态。页面只读权限呈现不代替服务端裁决。公共壳通过 ModuleErrorBoundary 隔离渲染异常，业务请求失败保留就地反馈。

引擎的 currentRelease 是上次成功收据确认的版本，不是实时站点探测。运行摘要始终称“上次确认版本”，执行器在线与站点健康分开表达。deploymentRuntimeStatus 只从目标及有限概览任务派生已知风险；恢复失败、部署阶段中断或清理异常的提示不随所选日志或详情分类消失。较晚成功收据可解除旧风险，时间无法排序时保守保留提示；概览未出现异常也不能证明现场健康。

运行结果待核对时可以尝试恢复上次确认版本，但继续遵守现有权限、活动任务、离线及历史可用性限制。执行器的现场指针一致性检查不变；拒绝恢复后仍须核对任务和现场，页面不保证自动修复。窄屏将次要动作放入原生菜单，源码包弹窗关闭后恢复到常驻菜单入口。

验证：DeploymentLogs.browser.test.tsx 覆盖增量去重、取消与迟到、任务身份不匹配、失败恢复与阶段展开；deploymentRuntimeStatus.test.ts 覆盖风险与成功收据时序；DeploymentDialogs.browser.test.tsx 覆盖历史配置、恢复尝试与配置完整性；ProjectAreasResponsive.browser.test.tsx 覆盖整页响应式、状态提示及菜单焦点；ModuleErrorBoundary.browser.test.tsx 覆盖局部恢复、导航保持及无隐式提交。组件与隔离页面测试不代表真实服务器发布或恢复已验收。
