# 工作台导航与配置体验

2026-10-29 用户确认按调研结果直接重构。视觉唯一参考仍为锁定 T3 Code v0.1.1（fe27e8e3）；下列外部项目只借鉴信息架构，不引入组件、源码、依赖、组织层级或新的权限模型。

## 开源调研与取舍

核对日期 2026-10-29。Star 为核对时 GitHub API 数值；活跃证据使用正式版本，不把自动更新时间当维护。均超过 1,000 Star、有启用的 Issues 及真实问题记录。

| 项目 | Star / 版本与日期 | 许可证 / 问题证据 | 借鉴与不采用 |
| --- | --- | --- | --- |
| [Coolify](https://github.com/coollabsio/coolify) | 65,205；[v4.5.3，10-28](https://github.com/coollabsio/coolify/releases/tag/v4.5.3) | Apache-2.0；[12370](https://github.com/coollabsio/coolify/issues/12370) | [项目—环境—资源](https://coolify.io/docs/concepts)分层；不迁入 Laravel/Livewire、Docker 部署实现 |
| [Dokploy](https://github.com/Dokploy/dokploy) | 38,096；[v0.30.10，10-22](https://github.com/Dokploy/dokploy/releases/tag/v0.30.10) | [非 proprietary 目录 Apache-2.0](https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD)；[5804](https://github.com/Dokploy/dokploy/issues/5804) | [项目与环境组织](https://docs.dokploy.com/docs/core/multi-tenancy)，实例管理分开；不使用专有目录、Next.js/tRPC 或 Docker Swarm 运行架构 |
| [Supabase](https://github.com/supabase/supabase) | 114,259；[v1.26.08，08-07](https://github.com/supabase/supabase/releases/tag/v1.26.08) | Apache-2.0；[52477](https://github.com/supabase/supabase/issues/52477) | [全局与项目分开导航、账号退出项目上下文](https://supabase.com/changelog/33670-upcoming-breaking-change-to-dashboard-navigation)，作为主要信息架构参考；不引入组织、计费或 Studio 依赖 |
| [Appwrite](https://github.com/appwrite/appwrite) | 57,788；[2.6.2，10-24](https://github.com/appwrite/appwrite/releases/tag/2.6.2) | BSD-3-Clause；[15047](https://github.com/appwrite/appwrite/issues/15047) | [Console 管理权限与项目资源分开](https://appwrite.io/docs/advanced/security/roles)；不迁入其组织角色或云服务配置 |
| [Portainer](https://github.com/portainer/portainer) | 38,737；[2.45.3，10-21](https://github.com/portainer/portainer/releases/tag/2.45.3) | Zlib；[13339](https://github.com/portainer/portainer/issues/13339) | [全局目录选择对象再进入](https://docs.portainer.io/user/home)，目录搜索与管理入口明确；不增加监控仪表盘、Kubernetes 或代理依赖 |

## 选定的信息架构

全局工作台是一个独立导航范围，包含全部项目、我的助手、全局 skills、平台节点和账号。项目目录用紧凑可搜索列表，点击项目进入该项目配置；不增加缺少真实数据的统计卡片。全局页面不展示某个项目的面包屑，不把全局按钮混入项目功能栏。个人偏好继续由原设置入口负责。

进入项目后，顶栏只显示问答、工作区、部署、skills、助手和项目设置；项目选择器宽度稳定，长名称省略并保留完整可访问名称。切项目保留合法模块，不携带上一项目的助手、环境或写入参数。全局页面选择项目进入项目配置。原深链继续可达，非法项目不回退到其他项目。

项目设置只呈现当前项目。侧栏为基本信息、环境、仓库与凭证、助手与成员；不再列其他项目，平台节点从全局工作台管理，项目环境只绑定和使用已授权节点。全局与项目 skills 管理分别显示对应范围；项目内可看到全局继承结果，不能在项目功能栏内修改所有项目。我的助手及电脑来源属于本人全局资源，项目助手列表仅显示本项目预设与获共享助手。

助手列表用 T3 SettingsGroup/SettingsRow，名称、模型和真实异常为主要信息。启停使用行内 Switch；编辑直接进入页面内表单，顶部有返回、取消和保存，字段按基本信息、运行配置、问答默认值与角色指令分组。使用同一保存/修订/原请求恢复接口，不把成功请求伪装为失败、不重复提交未知操作。只有对象的管理者有开关和编辑入口，共享来源不授予项目管理员提供者权限。离开未保存表单给予清晰选择；真实错误保留，正常“已停用”不重复三次说明。

## 部署节点接入与配置

环境节点弹窗保留绑定已授权节点，为平台管理员提供管理／接入节点和直达节点配置的入口。平台节点负责接入、跨项目分配和存储管理，环境内只展示摘要；跳转保留来源项目、环境及页面，返回后重新读取原环境节点。定位使用受校验的路由参数，刷新和前进后退保持上下文，未保存输入不得被轮询覆盖。

接入使用安装命令，先说明 Linux、管理员权限、Docker／Compose、HTTPS 和内部 CA 信任要求。页面只按真实注册及心跳展示等待或在线；未注册节点可重新生成一次性口令，旧口令失效，已注册身份不可覆盖。口令不进入地址、日志或浏览器持久存储。安装器先在临时目录下载和构建，再建立持久目录；仅回收本次创建且尚未投入使用的内容。

接入成功直接提供“分配到项目／环境”，每次选择一个项目及一个或多个环境，一次确认原子完成项目授权和绑定；保留仅授权项目及暂不分配。已有绑定不重复写入，解绑和撤回授权保持独立操作并说明影响，服务端仍裁决平台管理及环境动作权限。平台列表与详情直接展示配置和分配入口，不把首次使用的必经操作藏在更多菜单。

存储设置允许平台管理员在未分配、离线或任务执行期间保存。成功版本保留 2–20 个，专用构建缓存 1–20 GiB，默认均为 2；节点在线且空闲时应用。区分保存与应用、等待上线与等待任务、失败与不支持，显示最近报告和脱敏失败原因。降低预算提示清理影响；策略作用于节点全部项目，当前运行及恢复保护继续由部署引擎裁决。

验证限于节点往返导航、命令接入与失败恢复、分配事务和权限、策略冲突及真实状态反馈，不重复不受影响的整站流程。appSphere 继续保持平台节点，未收到明确分配操作时不得自动授权或绑定。

## 实施影响与验证

影响公共导航注册表、顶栏和面包屑；项目目录/配置侧栏；项目与个人助手编辑；skills 范围入口；平台节点呈现。服务端权限与执行合同保持原所有者，不重建持久化、模型或任务系统。涉及的布局统一使用当前 T3 页面容器、设置行、按钮、菜单、Switch、ScrollArea。

验收覆盖：全局/项目往返、切项目、无项目账号与撤权、深链、行内启停成功/失败/未知恢复、编辑保存/取消/离开、个人共享；代表性浅深色、390px/短窗口、长名称、键盘及焦点。每个可交付批次记录代码、本地验证、实际部署和真实页面验收，未测项明确标出。
