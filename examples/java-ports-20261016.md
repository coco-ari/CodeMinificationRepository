# Java 服务统一端口约定

适用服务器：`129.226.133.152`。四个 Java 服务由交付平台的 Agent 管理；旧 Jenkins / SSH 恢复流程已停用。

## 端口配置

同一个服务的代码配置、容器监听、宿主机映射和 Nginx 上游使用同一个端口号：

| 服务 | 代码及容器端口 | 宿主机映射 / Nginx 上游 | HTTP 上下文 |
| --- | --- | --- | --- |
| `brezze-communication` | `10110` | `127.0.0.1:10110` | `/communication` |
| `brezze-api` | `10111` | `127.0.0.1:10111` | `/api` |
| `brezze-manage` | `10112` | `127.0.0.1:10112` | `/manage` |
| `brezze-reward` | `10115` | `127.0.0.1:10115` | `/reward` |

端口仅映射到宿主机回环地址，公网通过 Nginx 的 HTTPS 域名访问。容器之间仍使用 Docker DNS 名称与对应容器端口通信，不能将服务间调用地址改成 `127.0.0.1`。

在控制台「服务与部署 → 服务详情 → 配置」维护部署位置的端口。API 示例为：

```json
{
  "host": "127.0.0.1",
  "hostPort": 10111,
  "containerPort": 10111
}
```

Nginx 共用转发文件为 `/etc/nginx/snippets/solstandard-java-locations.conf`。例如 `/api` 及 API 登录等独立规则都应指向 `http://127.0.0.1:10111`。保持中心保存的端口配置后，后续发布继续使用相同映射。

## 修改端口与验证

1. 确认目标宿主机端口空闲，备份中心数据与 Nginx 配置。
2. 修改中心部署配置，选择当前运行版本的分支和完整提交，通过平台重新发布，生成新的配置快照。仅保存配置不会改变已运行容器。
3. 服务在新端口健康后同步修改对应 Nginx 上游，执行 `nginx -t` 并平滑重载。
4. 同时核对中心的待发布配置、当前版本快照、Docker 实际端口及域名访问。

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl --fail --max-time 15 http://127.0.0.1:10111/api/swagger-resources
curl --fail --max-time 15 https://solstandard-api.abroad.besiter.com.cn/api/doc.html
curl --fail --max-time 15 'https://solstandard-api.abroad.besiter.com.cn/api/v2/api-docs?group=api'
```

容器健康不代表域名转发正确，验收必须包含外部入口。

## 2026-10-16 执行记录

四个服务均使用调整前正在运行的提交 `a710bdb3719032716c304df5af4849aecf85c445`、分支 `p-vi-sol`，通过中心 API 创建任务并由 Agent 执行，未直接修改历史发布快照。

| 服务 | 本次成功任务 |
| --- | --- |
| API | `606eedfb-c533-4f38-a18f-a6aca1350ad5` |
| communication | `97b49e7f-aae0-44db-a26a-52c0b5d68974` |
| manage | `53387f93-e796-40ab-b15c-dbbaf2490840` |
| reward | `a3a376c9-ede9-49c4-8037-e93866e5f147` |

验收结果：中心待发布配置、当前版本快照与 Docker 映射一致，四个 Java 容器健康，旧 `20110/20111/20112/20115` 端口空闲。三个业务域名的四个文档入口、API 接口定义以及后台和 H5 页面共 15 个 HTTP 检查均返回 200；中间件与 Agent 持续运行。

备份及执行记录：

- 中心服务器：`/opt/cmr-upgrades/unify-java-ports-20261016-042801/state.sqlite`。
- 业务服务器：`/opt/cmr-upgrades/unify-java-ports-20261016-122948/` 保存首次操作备份；`/opt/cmr-upgrades/unify-java-ports-20261016-123404/` 保存后续备份、最终报告和 HTTP 验证结果。

## 历史版本

端口调整通过新发布记录保存，不改写旧版本的配置快照。统一端口之前的版本可能仍记录 `201xx`；直接回退会恢复该历史配置。恢复前需核对快照与 Nginx 上游，不能假定旧快照已经改为 `101xx`。若只是需要旧业务代码，应优先选择对应提交，使用当前统一端口配置重新发布。
