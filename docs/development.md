# 开发与验证

先读 [AGENTS.md](../AGENTS.md)，再按 [规范索引](README.md)选择专项。重建顺序见[分波计划](../examples/autoops-rebuild-plan.md)，源码职责与依赖选择见 [AutoOps 模块入口](../autoops/README.md)。

## 当前状态

第一波已实现独立后端切片：空库初始化、真实本地账号与登录会话、项目/环境/成员、统一范围授权与 capabilities、必要审计、SQLite 升级、幂等创建、自动质量检查与 CI 配置。新代码在 `autoops`，不导入旧宿主、旧存储或旧 API。

这一波尚未接入前端、工作区文件链路、部署执行、T3 会话和客户本机；相关权限测试只证明裁决规则，不代表这些业务已实现。现有工作台继续由 `agent-demo`、`vendor/t3code` 与业务适配器运行；本波没有替换服务器上的既有环境。下一波按计划连接公共工作台、新身份与资料链路。

旧部署中心在 `src`，旧控制台与原型在 `web`。既有启动、真实环境操作与历史验证见对应目录和[历史平台说明](history/legacy-platform-readme.md)，不要把历史入口当成新产品启动命令。

## 运行条件与验证

验证基线为 Node.js **24.12.0**、根清单指定的 pnpm **11.25.0**。新代码使用 Node 原生 TypeScript 类型擦除和 `node:sqlite`；该 Node 版本会输出 SQLite 实验特性提示，升级运行时需要重跑数据库及入口测试。T3 的运行条件继续按 vendor 锁定清单核对。

从仓库根执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify:autoops
```

`verify:autoops` 与 CI 使用同一入口：Prettier → 严格 TypeScript → dependency-cruiser 完整扫描 → Node 测试。只修改格式时使用 `pnpm format:autoops`。依赖检查会因漏扫、深层导入、循环或非法依赖失败，类型导入也受检查。

本波本地验证通过 **21 项测试**：真实 HTTP 合同、独立初始化和服务入口、跨用户/项目/环境与外部范围、撤权与停用、会话恢复/注销/改密、幂等与撤权后重试、审计失败原子回滚、嵌套事务恢复、SQL 升级失败/校验值、密码计算限额及边界检查反例。扫描完整覆盖 **22 个业务源文件**。测试只用临时库和本机端口，不访问真实服务器或模型；CI 远端结果以对应提交的 Actions 状态为准。

## 首次本地启动

没有默认账号，也没有 HTTP 初始化后门。以下 PowerShell 命令选择独立数据目录，交互设置初始内部管理员；密码不写入命令文本或 Git 文件：

```powershell
$env:AUTOOPS_DATA_DIR = Join-Path (Get-Location) 'data/autoops-local'
$env:AUTOOPS_HOST = '127.0.0.1'
$env:AUTOOPS_PORT = '28900'
$env:AUTOOPS_PUBLIC_ORIGIN = 'http://127.0.0.1:28900'
$initialCredential = Get-Credential -UserName 'admin' -Message '设置新 AutoOps 初始管理员密码（12 至 128 字符）'
$env:AUTOOPS_ADMIN_USERNAME = $initialCredential.UserName
$env:AUTOOPS_ADMIN_NAME = '平台管理员'
try {
  $env:AUTOOPS_ADMIN_PASSWORD = $initialCredential.GetNetworkCredential().Password
  pnpm init:autoops
  if ($LASTEXITCODE -ne 0) { throw '管理员初始化失败' }
} finally {
  Remove-Item -LiteralPath Env:AUTOOPS_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $initialCredential = $null
}
pnpm start:autoops
```

初始化只允许空账号库运行一次。已有新产品数据只执行 `pnpm start:autoops`；不要为解决初始化冲突删除数据。旧格式数据库、未知升级版本和已修改升级会拒绝启动。

| 配置 | 默认/语义 |
| --- | --- |
| `AUTOOPS_DATA_DIR` | `data/autoops`，保存 `autoops.sqlite` 及其 WAL 文件；上例单独使用本地开发目录 |
| `AUTOOPS_HOST` | `127.0.0.1`，实际监听地址 |
| `AUTOOPS_PORT` | `28900`，整数 1–65535 |
| `AUTOOPS_PUBLIC_ORIGIN` | 对应端口的本机 HTTP 来源；必须是无路径的规范来源，外部来源必须 HTTPS |
| `AUTOOPS_ADMIN_USERNAME/NAME/PASSWORD` | 仅首次初始化使用；账号名以小写字母开头，3–64 位，允许小写字母、数字、点、下划线和连字符 |

准备远程部署时由反向代理终止 HTTPS，并将公共来源配置为真实地址。Cookie 的 Secure 属性由该来源决定；不能依靠浏览器改请求头绕过校验。数据目录权限只给运行服务的系统账号，Windows 下另外核对 ACL。

## API 使用边界

- 健康检查：`GET /health/live` 与 `GET /health/ready`；普通 API 均在 `/api/v1`。
- 登录 `POST /api/v1/login` 返回用户、CSRF 值和到期时间，并设置 HttpOnly、SameSite=Strict 会话 Cookie；刷新后用 `GET /api/v1/session` 恢复 CSRF。所有修改请求含与配置完全相同的 `Origin`；登录以外还须 Cookie 和 `X-CSRF-Token`。JSON 请求使用 `Content-Type: application/json`。
- 账号入口 `/accounts`：平台管理员创建、分页查看、停用/启用及重置密码；自己修改密码走 `/session/password`。改密、停用及注销立即使对应会话失效。
- 项目入口 `/projects`：内部成员创建项目并成为项目管理员；`/:projectId/environments`、`members`、`grants`、`capabilities`、`audit` 提供对应业务。输入字段以[合同](../autoops/contracts/index.ts)为准，方法和调用实例见 [API 回归测试](../autoops/test/foundation.test.ts)。
- 创建项目/环境带 UUID `Idempotency-Key`；同一操作者、操作和参数重试复用原结果，不同参数返回 409；每次重试仍检查当前授权。权限变化后即使 Cookie 尚未到期也不能继续原操作。
- 普通成员按环境显式授权，新环境不自动扩权；项目管理员使用项目范围。`environmentId: null` 不表示普通成员自动拥有全部环境。capabilities 只列已完成动作，不能替代服务端授权。
- 列表每页至多 100 条，按资源 ID 排序；使用响应的 `nextCursor` 作为下次 `after`，直到为 null。项目列表按授权过滤后可以出现空页，仍应继续游标。第一波未提供全文搜索、时间倒序审计或稳定快照分页。
- 错误统一为 `{error:{code,message,requestId}}`；常见状态为 400/401/403/404/409/429/500。跨项目不可访问资源返回 403，不以存在与否帮助枚举。响应与结构化日志不返回密码、令牌、SQL 或内部堆栈。

## 数据与交接

数据库使用外键、WAL、同步持久化和忙等待；业务与必要审计共用同步事务。升级账本记录顺序及 SQL 校验值，未来新增升级不能修改已应用 SQL。首次正式启用前还须完成计划中的完整业务、备份恢复与容量验证。

开发备份采用 SQLite 一致性备份 API；也可正常停止服务，确认全部数据库连接关闭后备份整个数据目录。不要从仍在运行的服务只复制主数据库文件。恢复先验证副本与升级版本，勿覆盖正在使用的数据；数据库升级后不能假定旧程序可直接读取。

新服务处理 SIGINT/SIGTERM 时停止监听并关闭数据库；本波没有外部执行中的任务。后续添加后台任务时补停止领取、执行结果核查与恢复语义。

改动新模块使用 `verify:autoops`；旧 `pnpm check` 主要覆盖旧脚本与 `web`，不证明新产品或 T3 全部通过。改动 UI 时另做 T3 类型/构建与实际交互验收，改动公共执行模块同时验平台和客户宿主。交接报告具体命令、结果和未测边界，常规开发不触发真实发布或设备操作。
