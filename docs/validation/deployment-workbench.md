# 部署工作台配置与发布闭环（2026-10-30）

## 实施范围

基线为 `feat/workspace-deployment-validation` 的 `a2a90521`，初次实现验收时为本地工作区修改，尚未提交或部署；后续发布结果另记。先修订[专项设计](../../examples/deployment-core-adaptation-plan.md#11-部署工作台服务配置权限与发布流程2026-10-30已确认)及[权限说明](../../examples/project-workbench-design.md#项目权限设计)，继续使用现有 T3 外壳、部署数据所有者、任务及 Agent。未合并 main、重建数据、修改模型或操作现有五个业务服务。

原有 `resource-deletion-design.md`、`rpc.ts`、`rpc.principal.test.ts` 的其他任务改动保持。初次实现验收阶段未创建提交、推送或改变内网实例的 `project-assistant-lite-v1` 配置。

## 完成的业务切片

- 进入部署先选择环境，侧栏仅显示该环境的服务；支持搜索、添加或复用共享服务。未保存环境关联的服务通过独立草稿入口继续，不混入环境服务列表。
- 服务信息、环境源码、部署位置分三步分别保存。静态站点与 Java 共用已有配置字段，保存不发布；管理员管理共享字段，环境运维只复用并配置已有服务。自动刷新保留输入及原条件键，确认核对最新配置后才采用新版本。
- 服务页默认发布，提供发布记录与配置页签。直接选择分支及具体提交；多仓库分别固定完整 SHA，确认时可展开本次配置。原源码包、档案下载、重启、回退、删除及增量日志入口保留。
- 流程阶段、耗时与恢复结果来自已有任务事件；缺失历史不伪造完成，节点连接与业务健康分别展示。环境、服务、位置、任务、页签及配置步骤进入受校验路由；隐藏暂停轮询、切换取消查询、拒绝迟到响应。
- 概览返回环境动作能力、共享目录及配置缺项。新增原请求只读查询与环境移除接口；原请求按操作人、原动作和范围授权，未知结果不自动重发。环境移除沿同一数据所有者保存清理计划，失败后可明确继续原请求，保留共享服务及其他环境。
- 静态路径来自 Agent 实际报告；旧 Agent 未报告时明确显示缺项和宿主机卷映射说明，不猜测路径，不自动配置 Nginx、域名或证书。新 Agent 安装包包含该报告能力。

## 自动检查与页面证据

下表各批结果独立记录，不累加重复用例。

| 验证 | 实际结果与范围 |
| --- | --- |
| 部署领域、HTTP 授权及适配器 | `test/t3-deployments.test.mjs`、`test/deployment-projects.test.mjs`、`test/deployment-http.test.mjs` 共 48 项通过。含混合环境角色、共享字段拒绝、固定 SHA、清理冲突、失败恢复及原操作者收据。 |
| 原生 HTTP 路由 | `deploymentNodes.test.ts` 定向用例 1 项通过，其他 11 项未运行。真实隔离 SQLite 和登录会话验证新增两条原生路由、CSRF、只读拒绝、收据隔离、删除环境关联后共享目录仍保留；未连接远端执行器。 |
| 浏览器链路 | `DeploymentAccess`、`DeploymentsWorkbench`、`DeploymentDialogs`、`DeploymentLogs` 四文件 57 项通过；后续仅对新增确认详情和位置删除定位复验工作台文件，10 项通过，不与前批累加。真实 Chromium 操作，业务响应为隔离模拟，不能等同真实发布。 |
| 页面覆盖 | 浅深主题、390px 与 1440px，环境读取失败恢复、五服务定位、前进后退、刷新后继续配置、静态/Java 分步保存、未保存输入、配置版本核对、弹层焦点恢复、撤权清理、未知结果和多仓库固定 SHA。截图在 Web 的 `.test-artifacts/` 下。 |
| 阶段计算 | `DeploymentProgress.test.ts` 2 项通过，检查阶段别名、实际完成和失败阶段，不以源码字符串匹配证明结果。 |
| 类型及边界 | 根托管入口、Web、Server、适配器类型检查通过；运行边界扫描 317 个源文件、0 错误。公共导航与部署组件通过部署公开入口导出。 |
| 构建 | Web 生产构建及 Server `vp pack` 通过；Agent 安装包生成并逐文件校验通过，共 20 个程序文件。 |
| 差分 | `git diff --check` 通过；新增或修改注释使用简体中文。 |

复现入口：

```powershell
node --test --test-concurrency=1 test/t3-deployments.test.mjs test/deployment-projects.test.mjs test/deployment-http.test.mjs
pnpm --dir vendor/t3code/apps/server exec vp test run src/autoops/http/deploymentNodes.test.ts -t '原生路由按登录身份'
pnpm --dir vendor/t3code/apps/web exec vp test run src/autoops/DeploymentAccess.browser.test.tsx src/autoops/DeploymentsWorkbench.browser.test.tsx src/autoops/deployment/DeploymentDialogs.browser.test.tsx src/autoops/deployment/DeploymentLogs.browser.test.tsx --project browser --no-file-parallelism
pnpm --dir vendor/t3code/apps/web exec vp test run src/autoops/deployment/DeploymentProgress.test.ts --project unit
```

本机浏览器命令使用已有 Chromium 可执行文件，通过 `T3_TEST_BROWSER_EXECUTABLE_PATH` 指定。完整命令日志位于忽略目录 `.deployment/deployment-workbench-*.log`，不将临时日志、截图或安装依赖提交进仓库。

## 环境问题与未测边界

- Windows 检出曾把固定旧发行源码夹具转换为 CRLF，导致原始摘要断言失败；已核对 Git 原件摘要完全一致，并用属性明确该夹具采用 LF，未改写旧发行内容或放宽断言。Windows tar 列表输出同样使用 CRLF，安装包校验现支持两种行尾，程序内容及条目边界检查保持。
- 单独尝试的两项完整发行包测试在建立既有符号链接夹具时被 Windows `EPERM` 阻止，未计入通过。Agent 自身实际打包和逐文件校验已通过；尚未完成 Linux 完整发行清单验收。
- 本机 Docker 守护进程未运行。未执行隔离静态站点及 Java 的真实构建、发布、健康、回退、恢复失败和断线验收；模拟任务与原生路由测试不替代这些结果。
- 未登录在线页面或检查现有业务服务健康，未更新中心或 appSphere Agent，未重新发布现有五个服务。`project-assistant-lite-v1`、模型、节点、已有配置及版本链没有服务器写入。
- 上线前仍需在独立 Docker 位置完成两种服务的真实验收，再对固定产物进行发行及内网健康核对；上线本身为单独操作。
