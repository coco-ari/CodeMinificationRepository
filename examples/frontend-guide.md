# 前端维护说明

控制台使用 React 19、Vite、Tailwind CSS 4 与 Radix 版 shadcn/ui。官方组件来自 https://ui.shadcn.com/docs/components，通过官方 CLI 生成后保存在 `web/src/components/ui/`；`components.json` 记录样式、路径别名和组件配置。后端继续使用 Node.js 与 SQLite。

## 开发与构建

```bash
pnpm install --frozen-lockfile
pnpm build
COOKIE_SECURE=false PUBLIC_ORIGIN=http://localhost:8080 pnpm start
```

`pnpm start` 会先执行完整构建。只需启动已经构建的生产程序时，使用 `node src/server.mjs`。构建产物为 `dist/web`，最终 Docker 镜像不包含前端依赖和开发服务器。

开发 UI 可在另一个终端运行 `pnpm dev:ui`，通过 Vite 地址访问页面；`/api` 请求代理到 `http://127.0.0.1:8080`。此时中心的 `PUBLIC_ORIGIN` 需要设为 Vite 的准确来源（默认 `http://127.0.0.1:5173`），并设置 `COOKIE_SECURE=false`；这样写请求仍通过来源和 CSRF 校验。建议生产行为与 CSP 检查始终访问中心 8080 端口。

```bash
pnpm run check
pnpm run check:ui
pnpm run build:ui
pnpm test
pnpm run test:browser
pnpm run test:deploy-browser
```

浏览器测试创建临时中心和测试数据，使用 Chrome/Chromium/Edge；可用 `BROWSER_PATH` 指定路径。测试包含项目内新增凭证、下载密码清理、键盘焦点与 Escape、管理表单、发布与回退、任务深链接、跨项目迟到响应和桌面/手机布局。部署回报使用模拟 Agent，真实容器行为仍须由独立 Docker 验收证明。

## 代码组织

- `web/src/App.jsx`：登录、下载入口、项目布局、哈希路由、会话和数据生命周期。
- `web/src/components/workspace-home.jsx`：固定高度项目卡片、整机资源、环境服务及更新入口。
- `web/src/components/release-workbench.jsx`：真实 commit 选择、已发布版本、完整配置和中心/Agent 任务流程。
- `web/src/components/pages.jsx`：项目、仓库、服务器、环境服务、部署与记录页面。
- `web/src/components/dialogs.jsx`：资源表单、确认操作、一次性密钥等表单。
- `web/src/components/target-form.jsx`：Java/Maven/Docker 部署配置。
- `web/src/components/shared.jsx`：表单布局、状态、空态等业务层组件。
- `web/src/components/ui/`：shadcn/ui 组件，使用本地 `lib/utils.ts` 的 `cn`。
- `web/src/index.css`：Tailwind、基础变量和业务布局，使用系统字体，无远程字体依赖。
- `web/src/styles/solid-glass.css`：在基础样式后加载的浅色玻璃主题，适配 Radix 状态与 Portal 浮层；保留实色表格、日志和嵌套卡片，并支持减少透明效果及高对比度模式。

新增组件使用 `pnpm dlx shadcn@latest add <component>`。核对组件 import 指向 `@/lib/utils`，不要引入重复的样式工具。提交源码与锁文件，随后运行 `pnpm format:ui` 和检查。保留组件的键盘操作、焦点管理与 ARIA 语义；共享表单在关闭时将焦点返回触发控件，秘密字段随弹窗卸载清除。

## Solid Glass 材质规范

后续 UI 修改以 [Solid Glass](https://github.com/deeplethe/solid-glass) 为浅色材质参考，通过本仓库 `web/src/styles/solid-glass.css` 适配 Radix。保留 shadcn/ui 组件、现有布局和业务行为，不直接复制上游针对其他组件状态的选择器。上游 MIT 许可保存在 `web/public/third-party/solid-glass-LICENSE.txt`。

| 区域 | 材质与圆角 |
| --- | --- |
| 主卡片、确认框 | 面板层，18px 圆角，顶部高光与柔和投影 |
| 表格外框 | 稳定实色底面，16px 圆角，内部行保持连续，不逐行加阴影 |
| 菜单、选择器浮层、提示与通知 | 浮层层，14px 圆角，高不透明度；选项使用 8px 圆角 |
| 内层卡片、配置片段、日志区域、提交选项 | 内层层，12px 圆角、轻边框；不叠加背景模糊和悬浮阴影 |
| 按钮、输入框、普通页签 | 控件层，10px 圆角；菜单项等紧凑内容为 8px，首页小控件为 6px |
| 贴边导航抽屉 | 只圆化露出的边缘，不为贴边一侧添加悬浮高光 |

以上尺寸统一由 `--glass-radius-*` 变量控制。嵌套 Card 自动使用内层材质；其他需要收敛视觉的 Card 显式设置 `data-surface="inset"`，不要依赖 `shadow-none` 与主题样式的加载顺序。开关、圆形徽标与下划线页签保留原形状。主要操作保留厚度，文字链接与菜单触发按钮保持轻量。

Button 的 `data-ui="button"` 是材质标记，`data-slot` 仍交给 Radix 组合组件使用，避免 Popover、DropdownMenu、Tooltip 包装后按钮样式丢失。新增组合控件需验证两类标记都保留。搜索型选择器的内部 Command 继承浮层圆角，限制背景溢出；不要为所有卡片增加 `overflow: hidden`，以免裁掉键盘焦点和非 Portal 内容。

Tooltip 统一使用无箭头浮层，与触发内容保持间距；不要依赖直接子元素选择器隐藏 Radix 包装后的箭头。提示、分支和选择器长文本须换行并限制在视口内。弹窗与抽屉的关闭按钮复用 Button 的轻量圆角与可见焦点，并为标题预留空间。选中勾、滚动箭头及状态标记保留其含义。

常规透明模式、减少透明效果、高对比度及 390 / 768 / 1280 / 1920 像素布局都要检查。截图应覆盖提示框展开、菜单展开、选项高亮、确认弹窗、日志和移动端导航，不以单张首页截图代替全站检查。

## 路由与状态

项目地址沿用 `#/projects/{id}/{view}?environment={id}&task={id}`；系统管理使用 `#/system/{view}`。默认进入测试环境。环境、服务页签和任务选择保存在 URL 中，可刷新和直接打开。服务页签以 URL 为准，支持同服务地址切换及浏览器前进后退；更换部署位置时保留当前页签。

项目切换会卸载旧空间、终止请求、关闭 SSE、清除页面与弹窗状态。即使旧请求在取消后仍返回，也会通过生命周期标记忽略。SSE 更新触发刷新；日志按序号补读、去重和文本渲染，断线时保留已显示内容，用户向上阅读时不强制滚到底部。

中心只提供构建时枚举的静态资源，客户端路径不直接参与文件读取。每个 HTML 响应包含不同的 CSP 样式 nonce，`get-nonce` 将它提供给 Radix 滚动锁；`script-src 'self'` 保持不变。生产没有第三方脚本、字体或 CDN 请求。

新发布入口为 `#/projects/{id}/release?environment={id}&target={id}`；配置入口为 `configuration`，原有 `tasks?task={id}` 使用完整任务页。视觉验收以 [原型落地记录](prototype-rollout-20261015.md) 为准。

## 原型布局约束

- 桌面侧栏宽 192px，1100px 以下收窄为 180px；手机使用 Sidebar 的抽屉导航。顶部通过 Breadcrumb 保留项目和页面返回入口。
- 项目卡片固定等高，每页完整显示 3 个服务，通过底部分页切换；服务数量和更新进度不改变卡片大小。服务行显示分支和运行 Commit，资源紧张时数值与进度条标红。配置分组纵向占满内容区，普通字段两列、手机单列；JVM、应用参数、端口和数据卷逐行显示，避免长字符串挤进狭窄列。
- 项目卡片使用 Card、Tabs、Badge、Progress、Separator、Button 和 Tooltip 组合。环境切换不叠加阴影，整机范围放入资源提示；状态文字与更新按钮居中对齐，Commit 前 8 位清晰、尾部渐隐，页脚计数和分页使用相同的辅助字号与颜色。Tooltip 的 `asChild` 可能覆盖子组件 `data-slot`，页脚按钮样式使用稳定的业务类名定位。
- 仓库概览与管理页共用连接状态组件：已连接、连接失败、待验证、已停用；空仓库显示已连接，并在 Tooltip 注明暂无提交。概览不展示默认下载分支；服务分支和 Commit 留在服务及发布页面。状态表示最近一次验证结果，提示中可查看验证时间。变更仓库地址、绑定凭证或共享凭证后旧结果失效，需重新验证。
- 仓库保留刷新、编辑和启用开关；下载地址、密码重置等收进 DropdownMenu。手机也能通过菜单编辑和启停；启停作用于仓库整体，包括发布和下载。
- 服务器卡片直接显示连接、整机资源及采集信息，项目内直接提供解除绑定按钮，系统管理保留操作菜单；移除重复的查看详情按钮与右侧详情面板。接入新服务器和绑定已有服务器放在同一工具栏，使用相同的 outline 按钮。项目内仅解除绑定，系统管理中才能撤销 Agent 接入。
- 概览管理入口与标题对齐；接入引导完成后自动收起。服务列表复用首页的运行版本识别逻辑，保留 Agent 发现的 Commit，不以缺少历史记录推断尚未发布。
- 环境列表的操作列直接提供编辑、删除，不再使用查看服务按钮和环境详情侧栏。删除经确认后执行；存在部署位置或历史引用时由后端阻止。删除当前环境后自动进入可用环境。
- 服务发布记录逐行提供回退入口，进入确认页时用 URL 的 `release` 参数固定所选版本；刷新和较早分页中的版本仍精确预选。当前版本用紧凑 Badge，源码下载直接操作、清理放入菜单，不堆叠可回退和源码归档徽标。
- 任务详情分为发布进度、任务快照和完整日志。进度区分别展示中心与 Agent 的阶段耗时，点击阶段筛选日志，可恢复自动跟随。任务快照读取创建时固定的源码与配置。
- 新增部署位置时，可选取同项目、同服务的已有配置，确认后填入表单。目标环境和服务器不变；Profile、网络与运行参数需核对，映射端口和静态站点地址必须重新填写。应用配置不保存、不发布，取消保留原输入。
- 健康检查默认显示 Java 的路径和容器端口，高级成功条件及等待参数在 Accordion 中按需展开；收起不清除参数。执行说明随输入变化，静态站点则说明 HTTP 200 和发布标记检查。
- 发布页支持按 SHA、说明、作者搜索最近 100 条提交；搜索不修改已选版本，切换分支清空搜索。没有匹配时可清空、切换分支或刷新提交。
- 任务日志支持当前阶段或全文文字检索，搜索期间不自动滚动；清空后恢复跟随。下载保留所有已加载日志，不受筛选影响；历史补读完成前禁用复制和下载，进行中任务导出截至当前的内容。
- 过渡使用短距离淡入、阶段状态变化和细进度条，遵循系统“减少动态效果”。加载提交与版本时显示 Skeleton，避免先闪现错误的空态。

本轮体验修改的取舍、逐项验证和前后截图见 [体验对比审查](ux-review-20261016.md)。

浏览器回归另覆盖仓库菜单与开关、长配置参数、阶段日志/完整日志切换、失败阶段、320/390/736/1024px 布局以及减少动态效果；截图写入忽略提交的 `.test-artifacts/`。
