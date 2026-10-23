# AutoOps 新产品代码

运行方式、实现状态及验证结果只维护在[开发与验证](../docs/development.md)。本目录遵循根 [AGENTS.md](../AGENTS.md)及专项规范。这里是已经实现的基础后端切片，不代表全部现有模块已完成优化；第二步仍须按工程规范核对公开边界、权限及故障隔离。

## 定位代码

| 目录/入口                                                           | 职责与数据所有权                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [contracts](contracts/index.ts)                                     | Effect Schema 输入与 DTO、角色、动作和错误码；前后端共同合同，不依赖服务端                                         |
| [identity](server/modules/identity/index.ts)                        | 账号、密码派生与会话；拥有 `identity_accounts`、`identity_sessions`                                                |
| [projects](server/modules/projects/index.ts)                        | 项目、环境、成员、创建命令幂等收据；拥有 `projects`、`project_environments`、`project_members`、`project_commands` |
| [access](server/modules/access/index.ts)                            | 统一动作与范围裁决、授权及 capabilities；拥有 `access_grants`                                                      |
| [audit](server/modules/audit/index.ts)                              | 允许字段的审计写入、获授权查询；拥有 `audit_events`                                                                |
| [platform](server/platform/ports.ts)                                | 连接、同步事务、配置、错误与注入端口；只拥有数据库升级账本，不查询业务表                                           |
| [app.ts](server/app.ts)                                             | 唯一组合根与 HTTP 适配；注入依赖、解析可信身份、调用模块服务                                                       |
| [start.ts](server/start.ts) / [initialize.ts](server/initialize.ts) | 监听服务 / 空库管理员初始化，两者使用同一模块实现                                                                  |

`index.ts` 是模块公开入口；`service.ts` 协调用例与事务；`domain.ts` 保存领域规则及仓储合同；`sqlite.ts` 只操作所属模块表。审计当前职责较小，暂不拆出没有作用的额外层。

账号有效性来自身份模块，所有账号管理及业务权限由授权模块裁决。组合根通过端口注入协调调用：身份读取不反调授权；创建项目在一个事务中写项目、成员、初始管理员授权、审计与幂等收据。模块可以协作，内部文件和 SQL 表不能成为跨模块捷径。

## 扩展切片

1. 先看专项规范和所属模块的服务、合同、测试，再确定操作与状态的所有者。
2. 在公共合同定义输入和能力，模块服务检查当前授权及真实资源范围。幂等返回旧结果前仍须授权。
3. 数据变更增加新的有序升级，不能修改已应用的 SQL；升级装配在组合根。网络、密码计算和文件处理放在同步事务之外。
4. HTTP 入口调用服务；需要 RPC/MCP 时调用同一服务。只有已闭环动作进入 `implementedActions`，尚未实现的权限测试场景不构成功能上线。
5. 增加业务回归测试并运行 `pnpm verify:autoops`。模块规则按目录自动注册；检查器核对全部源文件，测试按 `autoops/**/*.test.*` 发现，不能漏纳入新模块。

## 采用的开源能力

| 依赖                                                                 | 版本    | 许可证     | 采用原因                                                                      |
| -------------------------------------------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------- |
| [Effect](https://github.com/Effect-TS/effect)                        | 4.0.5   | MIT        | 沿用锁定 T3 的 Schema 体系，输入校验与类型同源                                |
| [Hono](https://github.com/honojs/hono)                               | 4.13.7  | MIT        | 复用路由、请求标识、正文限制与安全响应头，不另造 HTTP 框架                    |
| [Hono Node Server](https://github.com/honojs/node-server)            | 2.1.5   | MIT        | 官方 Node HTTP 适配器                                                         |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | 18.7.0  | MIT        | 静态分析真实导入、类型导入、公开边界和循环                                    |
| [SWC](https://github.com/swc-project/swc)                            | 1.15.11 | Apache-2.0 | 为依赖检查提供受支持的 TypeScript 解析器；类型检查仍使用仓库 TypeScript 7.0.2 |

版本固定于根清单和锁文件，许可证原文随对应依赖保留；制作发布包时保留所分发依赖的许可证与要求的声明。SQLite、密码派生、随机令牌、测试运行器使用 Node 标准库。这里没有新增自研框架、ORM、聊天执行器或组件库。

dependency-cruiser 当前默认 TypeScript 解析器不支持仓库的 TypeScript 7，所以显式使用 SWC，并通过漏扫检查和违规样例验证解析结果。SWC 只用于开发检查，不进入业务执行路径；以后升级解析器仍须保留这些检查。
