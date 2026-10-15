# 项目工作空间接口

所有接口沿用管理员会话；写操作使用 `X-CSRF-Token`。当前没有项目成员账号，项目范围检查用于保证资源归属和避免误操作。系统级管理员仍可以访问全局接口。

`workspaceId` 复用原 `deployments.applications[].id`。旧 `/api/projects/{id}/source/latest` 和 `/download/{id}` 继续表示仓库下载，不表示项目工作空间。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/workspaces` | 项目列表、运行概况、最近任务和迁移摘要 |
| `POST /api/workspaces` | `{name, description?}`；创建项目以及测试、生产两个空环境 |
| `GET /api/workspaces/{workspaceId}` | 项目详情；仅返回本项目仓库、绑定服务器、环境、服务、源码选择、目标及最近 200 个任务 |
| `PUT /api/workspaces/{workspaceId}` | 修改项目名称、说明 |
| `POST /api/workspaces/{workspaceId}/repositories` | 添加仓库；字段沿用旧仓库接口，项目归属由路径决定 |
| `PUT /api/workspaces/{workspaceId}/repositories/{id}` | 修改本项目仓库，不能转移归属 |
| `POST /api/workspaces/{workspaceId}/repositories/{id}/sync` | 同步默认下载分支 |
| `POST /api/workspaces/{workspaceId}/repositories/{id}/rotate-token` | 重置并返回独立下载密码 |
| `POST /api/workspaces/{workspaceId}/repositories/{id}/enabled` | `{enabled}`；停用或启用源码交付 |
| `GET /api/workspaces/{workspaceId}/server-candidates` | 可绑定服务器的 ID、名称、模式和在线状态，不包含其他项目容器或任务 |
| `POST /api/workspaces/{workspaceId}/servers` | `{name, mode}`；创建服务器接入记录并自动绑定项目，返回一次性安装命令 |
| `PUT /api/workspaces/{workspaceId}/servers/{serverId}` | 绑定已接入服务器，重复调用不增加重复记录 |
| `DELETE /api/workspaces/{workspaceId}/servers/{serverId}` | 解除绑定；仍被本项目目标引用时返回 409 |
| `POST /api/workspaces/{workspaceId}/environments` | `{name}`；新增空环境 |
| `PUT /api/workspaces/{workspaceId}/environments/{id}` | 修改环境名称 |
| `POST /api/workspaces/{workspaceId}/services` | `{name, module, kind?}`；`kind` 为 `java`（默认）或 `static`，模块为 Maven 模块或前端项目目录 |
| `PUT /api/workspaces/{workspaceId}/services/{id}` | 修改服务名称及模块；已有目标时不能更改类型 |
| `PUT /api/workspaces/{workspaceId}/environment-sources` | `{environmentId, serviceId, sourceProjectId, branch}`；设置环境中的服务源码 |
| `POST /api/workspaces/{workspaceId}/targets` | 沿用原目标配置字段；环境、服务须属于本项目，服务器须已绑定，并且已配置环境服务源码 |
| `PUT /api/workspaces/{workspaceId}/targets/{id}` | 更新运行配置；目标归属及管理方式仍不可改变 |
| `POST /api/workspaces/{workspaceId}/tasks` | `{targetId, action, releaseId?}`；单目标 deploy/restart/rollback |
| `GET /api/workspaces/{workspaceId}/tasks/{id}?after=0` | 本项目任务详情和增量日志 |
| `GET /api/workspaces/{workspaceId}/targets/{id}/releases` | 本项目目标的历史版本 |
| `GET /api/workspaces/{workspaceId}/events` | 本项目 SSE 更新通知；共享服务器心跳会通知绑定的项目，不包含其他项目目标或任务详情 |
| `GET /api/credentials` | 可供仓库表单选择的共享凭证元数据，不含密码 |

服务器和部署目标默认直接用于平台部署，不再提供模式选择或切换接口。创建请求可省略 `mode`；为兼容旧客户端仍接受 `managed`，其他值返回 400。旧监控目标升级后停止下发并保留历史，不能转换为平台目标。

系统级 `DELETE /api/deploy/servers/{serverId}` 删除已撤销且无部署目标、发布历史的服务器记录，同时清理空项目绑定并记录审计。仍沿用管理员会话和 CSRF。

仓库字段为 `{name, repository, branch, credentialId?, enabled?}`。`branch` 是默认下载分支，环境服务配置中的 `branch` 是发布分支。关联键为 `(environmentId, serviceId)`，同环境同服务的不同服务器共用该源码选择。

项目详情中的服务器容器列表按项目过滤，指标仍是整台机器的指标。其他项目资源通过项目范围的详情/写接口访问时返回 404；未绑定服务器或缺少源码选择返回 400。原有观察权限、撤销状态及目标忙碌校验继续执行。

新任务包含 `sourceSnapshot`（仓库 ID、名称、所属项目、地址、分支及凭证 ID）和独立的部署配置快照，不保存 Gitee 明文凭证。Agent v1 仍领取已有任务格式中的固定 ZIP、版本、摘要和配置，无需协议升级。

目标配置的 `kind` 由服务类型确定，不能通过提交配置绕过。前端 `static` 配置包括 `buildImage`、`module`、`artifactPath`、`packageManager`（npm/pnpm）、`packageManagerVersion`（准确 pnpm 版本）、`buildScript`、`buildArgs`、`build` 和 `health`。`health.url` 为 Agent 可访问的站点根地址，`bodyIncludes` 可选；版本标识与首页必须返回 HTTP 200。静态目标不配置运行镜像、端口、网络或存储卷，`containerName` 为 null。配置示例与首次接入见 [前端部署](static-sites.md)。

Agent 注册和心跳可附带 `capabilities` 字符串数组。前端任务要求 `static-site-v1`，旧 Agent 不满足时中心返回 409；领取前也会复查，避免降级后的旧 Agent 执行静态任务。Java 保持原有行为。静态目标只支持 deploy/rollback，拒绝 restart。静态版本通过 `{kind: "static", artifact: "static/<targetId>/<releaseId>"}` 引用本机版本目录，不能引用其他目标；历史版本仍关联固定 commit、任务与日志。

持久数据仍使用 SQLite 中的状态文档，部署数据版本提升为 `deployments.version = 2`（旧中心会拒绝启动），新增 `deployments.workspaceVersion = 1`、`serverBindings`、`environmentSources` 和 `workspaceMigration`；仓库增加 `applicationId`。升级采用事务与版本标记，不改变 Agent 身份和既有容器归属标签。

## 发布工作台源码选择

- `GET /api/workspaces/:project/targets/:target/source`：返回当前环境仓库分支的缓存提交（最多 100 条）、刷新时间和 `sourceKey`。
- `POST /api/workspaces/:project/targets/:target/source/refresh`：刷新远端记录，不创建部署任务、不修改默认下载分支。
- 创建发布任务可以传 `revision`（完整 SHA）和 `sourceKey`。后端验证记录归属与当前配置，固定指定提交；不传 `revision` 时仍发布分支最新代码。
- 项目列表新增 `dashboard`，只包含各项目自己的环境、服务、源码选择、绑定服务器指标及简化目标、活动任务。不含凭证或完整运行参数。
- 任务阶段增加中心 `source_fetch`、`source_resolve`、`source_archive` 和新 Agent 的 `image`；旧 Agent、旧任务继续有效。
