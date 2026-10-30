# 中心源码 ZIP 与包内配置

2026-10-30 用户确认：企业版新建测试分支，业务环境配置中的连接参数、账号及明文密码可以正常修改、提交、推送，随中心源码 ZIP 固定。对外资料的脱敏要求不能用于禁止业务部署配置保存密码；凭据适用范围只在 [AGENTS.md 的交付纪律](../../AGENTS.md#交付纪律)维护。以固定 Git 提交的 ZIP 为发布、回滚依据，不建立独立外置配置版本系统。

## 已完成的代码

- 对照本地固定 `main` 提交 `38e20cfc417d16585965f158e0be584b6f046143`，复用中心源码归档、SHA256 校验、节点构建及发布版本链。
- 本次待发布 Agent 代码的显式回滚始终从中心下载历史 ZIP 并重建；本机已有镜像或 ZIP 缓存不代替这次下载。缺少源码或授权时停止，下载和校验失败不切换当前业务版本；此处不表示线上 Agent `1.6.2` 已具备本次修改后的回滚行为。
- 中心创建回滚任务时必须存在原源码档案，目标 Agent 必须具备已有的源码档案恢复能力；保留幂等、授权、历史部署参数、失败自动恢复和版本链。
- `AGENTS.md` 与部署专项规范已同步上述规则，密码不得进入日志、截图或无关代码，源码与 ZIP 下载继续按项目权限授权。

## 企业版早期内网配置准备

本节记录早期独立工作区的准备结果，不是随后实际发布到 `47.102.123.105` 的配置或版本。

工作区 `D:/work/workbench/appsphere-intranet-test`，分支 `codex/appsphere-intranet-test`，基线为 `pos-rent-preauth-fondy` 的 `075537ced1fc3b008c5b4e8a3c0269b3ccadf8bc`。原工作区和未跟踪文件保持。

五个服务各自的 `application-test.yml` 已加入与当前运行环境一致的 27 项连接及调用配置；内网 MySQL、Redis、RabbitMQ 使用 `10.2.2.7`，数据库为 `brezze_saas_internation`、Redis DB 15、RabbitMQ 虚拟主机 `/appsphere-qiye-test`。每个服务新增包内 `logback-test.xml`，日志目录仍为 `/app/logs`。解析及逐项核对通过，配置正文与密码未打印。仅修改 test 配置、日志文件及分支部署说明，不修改业务代码或其他环境。

## 早期 Linux 验证结果

- Linux 隔离容器的直接相关 4 个测试文件共 85 项全部通过：`test/agent.test.mjs`、`test/source-cache.test.mjs`、`test/deployment.test.mjs`、`test/deployment-workspace-source.test.mjs`。覆盖 Java／静态回滚重建、原 ZIP 与配置固定、本机缓存不能替代中心下载、下载失败保护、版本链、源码隔离和撤权。
- 测试容器没有 Docker Socket 或业务数据挂载，使用临时数据及虚构凭据；HTTP 只在容器自身回环网络运行，未发布真实业务服务。
- Windows 同类执行存在目录链接 `EPERM` 和静态目录相关失败，未计为通过；Linux 初次执行还发现两个旧缓存断言及测试输入缺少构建网页，修正测试合同和隔离材料后取得上述完整通过结果，不删除失败用例或放宽安全断言。
- 改动的 JavaScript 语法检查、`git diff --check` 及 Agent 20 个程序文件的安装包构建／一致性校验通过。

本地过程在忽略目录 `.deployment/zip-release/`，Linux 原始和最终测试材料在 workbench 的 `/opt/autoops/build/zip-release-tests/`，最终结果为 `tests-final.log`。

## 2026-10-31 提交前检查

- 用户已明确要求提交推送运维工作台，本批代码按中心 ZIP 回滚和会话删除回执两个独立修改提交；不部署工作台或更新服务器 Agent。
- 当前 Windows 下的 4 个相关 Node 测试文件共 89 项，81 项通过、7 项失败、1 项跳过。失败涉及 Windows 符号链接权限及其静态目录后续操作，跳过项依赖 Linux 内核锁；未将这些用例记为通过。过程日志在忽略目录 `.deployment/workbench-commit-20261031/`。
- 未重新取得 Linux 执行结果：本机 WSL 的虚拟磁盘缺失，标准 SSH 密钥登录失败；自动审批拒绝从历史会话提取密码，未执行该操作。复用上述 Linux 85 项历史证据前，已核对当前 `agent/client.mjs`、`agent/static-deployment.mjs` 全文以及 `agent/executor.mjs` 的 `recoverRelease` 与当时测试候选一致；当前新增环境文件用例以本次 Windows 结果为准。
- 会话 RPC 定向测试 7 项、服务端类型检查、3 个改动 JavaScript 文件的语法检查通过；本地 Agent 安装包构建包含 21 个程序文件，未发布或替换在线安装包。

## 企业版实际迁移与剩余验收

企业版已在原工作区 `D:/work/java-appsphere-global-qiye` 的 `pos-rent-preauth-fondy` 分支完成提交推送，实际发布提交为 `33b370a26bff8416421e7b3ccbefc42ad57fc0a1`。经工作台和 Agent `1.6.2` 部署到 `47.102.123.105` 后，五服务健康检查通过。`application-test.yml` 随 JAR 打包并按 Profile 加载，日志挂载 `/app/logs`，原日志压缩规则及 Java 业务代码保持；API 原环境变量与证书路径保留，五服务只读挂载原 JDK 信任库，设备 TLS 和认证后的消息消费已验证。广告目录迁移前后完成文件数量、大小和摘要核对，原目录保留备份。

本次工作台新增的强制中心 ZIP 回滚和会话删除回执修复尚未部署。在线中心仍为此前 `36e7df04` 环境文件发行，服务器 Agent 保持已安装的 `1.6.2`；提交推送不改变其运行行为。后续统一更新中心及 Agent 后，仍需真实验证从中心历史 ZIP 重新下载、构建并回滚；隔离测试和已完成的企业版迁移不替代这项验收。
