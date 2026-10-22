# Skills Manager 管理机制的 Web 适配

管理与技能分配流程来源：<https://github.com/xingkongliang/skills-manager>，版本 `1.43.0`，固定提交 `7a2219219287f4ef4c543fc169ebcc5b0bff085c`。按用户要求保留“以技能为中心、卡片直接分配”的操作方式；前端组件和视觉仍采用仓库内锁定的 T3 Code，不迁入 Skills Manager 的桌面样式和 Tauri 调用。

本目录保留上游 MIT 许可、相关 Rust 源码及技能卡片/分配组件原件。`upstream/` 是来源证据，不参与 Node 构建，也不是一个已安装的 Rust CLI。`manifest.json` 保存原件的 SHA-256。任何升级必须重新分析并更新锁定提交和清单。

## 实际复用

| 上游模块／函数 | AutoOps 适配实现 | 差异与原因 |
| --- | --- | --- |
| `core/installer.rs` 的 `PreparedSource::from_archive`、`copy_skill_dir`、`install_skill_dir_to_destination` | `skill-library.mjs` 的 `prepareFiles`、`scanDirectory`、`publishVersion`、`importArchive` | 保留完整普通文件树、识别单个技能包根目录、跳过 `.git` 和生成缓存；服务端拒绝危险链接，而不是静默丢失文件。使用现有 `agent/archive.mjs` 校验 ZIP 路径、CRC、压缩与大小预算。 |
| `core/skill_metadata.rs` 的 `parse_skill_md`、`parse_frontmatter` | `metadata` | 沿用 YAML `name`/`description`；使用项目已经采用的 `yaml` 解析器，支持多行说明；服务器限制稳定 name 字符集，不把用户提供的路径当安装目录。中央 `SKILL.md` 源字节保持不变。 |
| `core/content_hash.rs` 的 `walk_content_files`、`hash_entries` | `prepareFiles` 中排序 manifest 与 SHA-256 | 保留按路径排序、排除生成缓存和包含 executable bit 的内容范围。采用有结构的 `[path,size,sha256,executable]` JSON，避免上游直接拼接路径与内容的边界歧义。读取或校验失败必须报错。 |
| `core/sync_metadata.rs` 的临时文件＋fsync＋rename | `atom` | 仍以原子索引发布管理状态；完整包先写入 staging 并回读 hash，再 rename 为不可变版本。版本更新不覆盖已有包。 |
| `core/repo_lock.rs` 的跨进程仓库锁 | `withLock` | Node 使用现有内置 SQLite 的 `BEGIN IMMEDIATE` 取得操作系统跨进程写锁；进程退出自动释放，避免 PID 文件锁的抢占竞争。锁库不保存业务数据。Git 网络获取在短写锁外完成，发布时复核 revision。 |
| `core/skill_store.rs` 的来源及 installed commit/content hash | skill/version 的 `source`、`contentHash` | 公开 HTTPS Git 必须指定 40 位提交、可选择子目录；Markdown、ZIP、Git 都保留来源类型。更新产生版本，分配固定版本，不自动升级正在使用的目标。 |
| `commands/projects.rs` 的中央仓库→项目；`core/sync_engine.rs` 的归属与冲突保护 | assignment 与 runtime 的范围解析 | 桌面 Agent 工具目录改为 AutoOps 业务助手／项目 ID；同技能项目分配优先，显式停用不会回退助手。按 internal/external 再过滤，运行器使用授权快照及只读文件工具。 |
| 中央库与目标引用分离、卸载保护 | `remove` 与 `unassign` | 有任何分配时禁止从中央库移除；移除只写 tombstone，永久保留不可变版本供已有会话恢复，不删除运行中的包。 |
| `views/MySkills.tsx` 卡片网格与 `SyncDots` | 中央库技能卡片、助手直接切换、每目标加载反馈 | 保留技能名称/说明/来源和同卡分配入口；Tauri 的 sync/unsync 接到现有 `assign/unassign`。图标改为可读的业务助手名称与选中状态，视觉复用 T3 `ThemeSearchSection` 卡片及原生按钮，不沿用浮升阴影。 |
| `SkillDetailPanel`、`SkillProjectsSection` | 按需文件详情、卡片项目入口、项目目标搜索和逐项分配 | 上游项目分配在详情，按用户本轮要求将入口前置到卡片；AutoOps 项目以业务 ID 和权限范围授权。取消仅撤回分配并保留包，不执行上游删除项目文件的操作。 |
| `AgentToggleSection` 的可用/不可用状态与详细目标说明 | 分配状态、未就绪原因与版本/工作区范围设置 | 上游此组件涉及 preset 工具开关；AutoOps 不引入 preset，不将其混同技能全局启停。全局启停继续保留为独立管理操作。 |

## 分配交互的适配规则

卡片直接显示助手分配，项目列表的选中状态表示该项目有单独分配。项目未单独分配时沿用助手设置；取消项目分配会恢复这层继承，不等于完全禁用技能。新增快分配使用卡片显示的就绪版本，默认仅内部；已有停用分配恢复时保留原版本和全部工作区范围。取消分配后再次添加是新分配，不声称恢复已删除的配置。版本升级、外部范围和完整分配信息继续在原生设置弹窗中管理。

首页展示技能集合与分配，文件目录和预览在点击技能后打开。此调整对应上游的高频操作布局：用户在看到技能时就能看到并修改目标，不必先进入文件页再找更多菜单。

## 为什么没有直接启动原 CLI

上游 CLI 与 Tauri 桌面端在同一 Cargo 包，`Cargo.toml` 直接依赖 Tauri、桌面插件及系统集成库，并没有独立的无桌面核心 crate。本次环境没有 Cargo/Rust 工具链。为避免仅为服务器文件管理引入桌面构建链，本次将上述实际函数机制移植到现有 Node 服务；**没有声称原 CLI 已构建或运行**。

这不是完整重写上游产品：首轮只迁入中央技能包、来源与版本、范围分配、真实回读验证、停用和移除。上游设备备份、桌面工具探测、用户 home 目录同步、托盘和自动全局升级不属于 AutoOps Web 范围。

## 运行边界

中央库完整保存 `scripts/`、资源、参考资料和依赖清单。包含脚本、依赖、明确命令执行指令（包括 Shell 代码块）或未开放工具的版本标为 `restricted`，可管理和预览，不能分配或作为 `ready` 技能调用；不会执行 npm/pip 或任意 Shell。只含指令与资料且与当前授权工具兼容的包可进入 T3 原生发现、选择、固定版本和调用流程。技能分配不增加项目、环境或宿主机权限。

技能状态分为已入库、已分配、运行条件就绪；“包已保存”不等于“脚本已能执行”。当前暂无通用依赖沙盒／脚本执行器，也不假称形成这类能力的闭环。

## 存储与兼容

`data/t3/skill-library-v2/index.json` 管理技能与分配，`versions/<skillId>/<versionId>/` 保存不可变文件树。原来的 `skills-library.json`／`skills-registry.json` 保留不动，首次迁移原有说明、正文、启停状态。内置技能保留两类工作区使用范围；已有自定义技能默认仅内部，管理员可显式批准外部范围。显式空旧库保持为空。

版本与权限由服务器解析，Web 不接受任意安装路径。本地绝对路径导入不开放给远程用户，改为上传 ZIP；Git 网络策略沿用已有工作区公开 HTTPS host allowlist、禁凭据、禁跳转、禁 file/ext 协议、禁 hooks、大小预算及超时。

就绪检查是当前能力范围内的结构检查，不是任意自然语言技能的兼容证明；实际调用仍受固定工具和资料权限约束，不能借助技能扩大权限。
