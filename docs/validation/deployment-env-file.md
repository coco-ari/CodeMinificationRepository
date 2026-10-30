# Java 部署可选环境文件

2026-10-30。基线为 `feat/workspace-deployment-validation` 的现有工作区；原有中心 ZIP 回滚、权限和文档修改保留。本批只增加 Java 配置的可选 `envFiles`，未修改 Java 业务代码、普通网络、端口映射、平台卷、Profile 或 Logback。

## 实现与兼容边界

- 表单的“网络与存储”中可按顺序填写环境文件路径，配置详情及发布确认显示路径和恢复边界。字段缺省或为空时规范化结果省略该字段，原配置键、Compose 清单和普通 Docker restart 保持；静态站点拒绝非空环境文件配置。
- Agent `1.6.2` 通过 `env-file-v1` 声明能力。创建发布、重启、回滚和领取任务核对新能力以及当前成功版本的恢复需要；未启用的项目继续允许原 Agent。配置草稿保存不会改动运行服务。
- 文件在部署节点预置，必须能由 Agent 内的 Compose 读取；现有容器化安装已挂载 Agent 数据目录，可把文件放到该目录的 `env-files` 子目录，例如 `/opt/cmr-agent/env-files/api.env`。不自动搬迁旧文件、不把内容提交到中心，也不增加业务容器宿主机目录挂载。
- 节点检查规范路径、普通文件、可读性、1 MiB 上限和系统／身份目录边界，再使用原生 `docker compose config --quiet` 校验解析；失败发生在构建和服务切换之前。含环境文件的 Compose 输出不进入任务日志，解析错误用不含变量值的提示报告。
- 只有已启用环境文件的当前成功版本，重启操作才使用原镜像强制重建容器，重新读取环境文件；不重复 Maven 构建、不新增成功版本。代码回滚固定历史源码与路径，文件内容仍以节点当时内容为准；不创建独立配置版本系统。
- 新项目日志可用现有 `logs → /app/logs` 平台卷及应用参数 `--log.path=/app/logs`；原有 Logback 压缩、分卷、保留和慢 SQL 策略继续执行。Spring YAML 随 JAR 打包，仍使用现有 Profile 参数。此处不自动修改任何存量位置的日志设置。

## 验证结果

- `test/env-files.test.mjs` 与 `test/deployment.test.mjs` 共 39 项通过：覆盖空字段兼容、路径和文件拒绝、原配置键、普通项目旧 Agent 下发、能力降级、固定任务输入、当前成功配置重启与错误脱敏。
- 新增的 2 项 Agent 流程用例通过：环境文件更新只重建原镜像并保持版本链，文件缺失或解析失败不构建、不切换、不泄漏解析错误中的值。
- 排除其他任务的 ZIP 回滚与 RPC 改动后，固定发行候选的 Windows Agent 文件整体运行结果为 28 通过、6 失败、1 跳过。6 项为已有静态发布符号链接 `EPERM` 及其后继断言，之前基线执行也失败；Linux 内核锁用例按环境跳过，不计全量 Agent 通过。
- `DeploymentDialogs.browser.test.tsx` 使用本机 Chrome 执行 18 项全部通过，包含新增环境文件填写、提交和配置详情；初次因缺少 Playwright 配套 Chromium 未运行成功，随后使用仓库已有 `T3_TEST_BROWSER_EXECUTABLE_PATH` 配置完成验证，没有修改浏览器运行依赖。
- Web 类型检查、生产构建及 Agent 安装包构建／一致性校验通过；安装包包含新增模块，共 21 个程序文件。构建的既有大分块和 sourcemap 提示保留。

- 运行模块边界检查扫描 319 个源文件，报告 1 项既有错误：DeploymentsWorkbench.tsx 直接引用 deployment/repositoryQueries.ts；该文件与 HEAD 一致，本批未修改。新增 Agent 模块已进入扫描，不将整体边界检查记为通过。

## 未上线及未测范围

未提交、推送或部署中心与 Agent；原有业务容器未操作。当前主机没有可用 Docker 守护进程，尚未执行真实 Linux Docker 环境变量注入及真实业务迁移，模拟 Docker 流程不替代这两项验收。源项目的中间件地址、证书和其他配置适配不计为本批已完成。
