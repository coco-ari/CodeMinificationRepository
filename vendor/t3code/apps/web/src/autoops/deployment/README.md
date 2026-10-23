# 部署前端模块

本目录维护已有服务发布、回退、配置确认及任务日志呈现。公开页面仍为父目录的 DeploymentsPanel，所有数据调用经过父目录 deployments 客户端；不拥有服务端任务状态、不直接调用工作区文件接口。

- DeploymentsPanel：项目/环境/服务选择、概览刷新、待核对请求与幂等提交协调。未知提交结果只重试原 requestId，页面错误重试不会自动发送。
- DeploymentDialogs：目标配置表单、固定配置快照及源码包/历史版本确认。只向协调组件提交 DTO。
- DeploymentLogs：单个固定项目/服务/任务的增量游标、请求取消、阅读位置、阶段及失败恢复详情。切换身份重新建立本地日志状态。
- ConfigurationDetails：目标配置只读展示。
- DeploymentControls / deploymentPresentation：当前实际共用的原生控件组合与格式化，无业务请求和授权规则。

依赖方向为页面协调到本目录和 deployments/workspaces 公共 DTO；子组件不导入页面内部状态。页面只读权限呈现不代替服务端裁决。公共壳通过 ModuleErrorBoundary 隔离渲染异常，业务请求失败保留就地反馈。

验证：DeploymentLogs.browser.test.tsx 覆盖增量去重、取消与迟到、任务身份不匹配、失败恢复与阶段展开；ModuleErrorBoundary.browser.test.tsx 覆盖局部恢复、导航保持及无隐式提交。全页另运行根 test/t3-module-shell-ui.mjs 与部署验证的只读浏览器检查；组件测试不代表真实服务器发布已验收。
