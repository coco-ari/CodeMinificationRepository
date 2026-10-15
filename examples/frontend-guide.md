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
- `web/src/index.css`：Tailwind 与主题变量，系统字体和中性黑白主题，无远程字体依赖。

新增组件使用 `pnpm dlx shadcn@latest add <component>`。核对组件 import 指向 `@/lib/utils`，不要引入重复的样式工具。提交源码与锁文件，随后运行 `pnpm format:ui` 和检查。保留组件的键盘操作、焦点管理与 ARIA 语义；共享表单在关闭时将焦点返回触发控件，秘密字段随弹窗卸载清除。

## 路由与状态

项目地址沿用 `#/projects/{id}/{view}?environment={id}&task={id}`；系统管理使用 `#/system/{view}`。默认进入测试环境。环境和任务选择保存在 URL 中，可刷新和直接打开。

项目切换会卸载旧空间、终止请求、关闭 SSE、清除页面与弹窗状态。即使旧请求在取消后仍返回，也会通过生命周期标记忽略。SSE 更新触发刷新；日志按序号补读、去重和文本渲染，断线时保留已显示内容，用户向上阅读时不强制滚到底部。

中心只提供构建时枚举的静态资源，客户端路径不直接参与文件读取。每个 HTML 响应包含不同的 CSP 样式 nonce，`get-nonce` 将它提供给 Radix 滚动锁；`script-src 'self'` 保持不变。生产没有第三方脚本、字体或 CDN 请求。

新发布入口为 `#/projects/{id}/release?environment={id}&target={id}`；配置入口为 `configuration`，原有 `tasks?task={id}` 使用完整任务页。视觉验收以 [原型落地记录](prototype-rollout-20261015.md) 为准。

## 原型布局约束

- 桌面侧栏宽 192px，1100px 以下收窄为 180px；手机使用 Sidebar 的抽屉导航。顶部通过 Breadcrumb 保留项目和页面返回入口。
- 项目卡片固定等高，每页完整显示 3 个服务，通过底部分页切换；服务数量和更新进度不改变卡片大小。服务行显示分支和运行 Commit，资源紧张时数值与进度条标红。配置分组纵向占满内容区，普通字段两列、手机单列；JVM、应用参数、端口和数据卷逐行显示，避免长字符串挤进狭窄列。
- 仓库保留同步、编辑和启用开关；下载地址、密码重置等收进 DropdownMenu。手机也能通过菜单编辑和启停。
- 任务详情分为发布进度、任务快照和完整日志。进度区分别展示中心与 Agent 的阶段耗时，点击阶段筛选日志，可恢复自动跟随。任务快照读取创建时固定的源码与配置。
- 过渡使用短距离淡入、阶段状态变化和细进度条，遵循系统“减少动态效果”。加载提交与版本时显示 Skeleton，避免先闪现错误的空态。

浏览器回归另覆盖仓库菜单与开关、长配置参数、阶段日志/完整日志切换、失败阶段、320/390/736/1024px 布局以及减少动态效果；截图写入忽略提交的 `.test-artifacts/`。
