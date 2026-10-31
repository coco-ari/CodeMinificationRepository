# 前端维护说明

产品呈现与交互统一遵循 [T3 UI 规范](t3-ui-standard.md)，代码与状态管理遵循 [工程规范](engineering-standard.md#前端代码与状态)。当前只有 T3 工作台前端；旧后台、旧问答及交互原型已退出源码、构建与专属依赖。

## 唯一入口与组件来源

- `web/agent-demo.html` 与 `web/src/agent-demo/main.jsx` 提供同源登录和工作台启动；目录名保留宿主集成含义，不包含旧问答界面。
- `web/src/agent-demo/t3/` 在认证后安装宿主快照并加载 T3 的真实路由与运行时；登录和错误反馈也使用同一组件来源。
- `vendor/t3code/apps/web/src/components/ui/` 提供锁定 T3 的原生 Base UI 控件；基础组件不再经过 Radix、cmdk 或 Sonner 适配层。上游来源与许可证继续由 `.autoops-source/` 及原许可清单维护。
- `vendor/t3code/apps/web/src/autoops/` 组合业务页面、数据边界及共享模块槽位。沿用 `AppSidebarLayout`、`ModuleWorkspace`、`WorkspacePageHeader`，不复制页面壳。
- `vite.config.ts` 只构建当前工作台入口，`~` 指向锁定 T3 Web 源码。业务组件不能重新引入独立主题或基础控件目录。

## 组合方式

文件与日志复用原生满高文件工作台；配置复用 `SettingsSection` / `SettingsRow`；skills 目录复用原生紧凑卡片。通用控件的尺寸与外观由共享变体维护，业务调用只组合布局。中文化、权限反馈、未知结果恢复、长列表滚动、输入法及焦点行为一并保留。

## 开发与验证

```sh
pnpm dev:ui
pnpm build:ui
pnpm test:browser
pnpm test:deploy-browser
```

浏览器回归由锁定 T3 的 Vite+ / Playwright 执行，使用隔离业务夹具；可通过 `T3_TEST_BROWSER_EXECUTABLE_PATH` 指定已安装的 Chromium。构建与测试环境仍按冻结锁文件安装依赖。真实站点更新后另核对版本、健康、实际模块切换、主题、窄屏、短窗口与关键浮层交互；自动夹具通过不代替实站验收。

本批实现与证据见[原生组件统一](../docs/validation/frontend-native-ui.md)。后端、部署 Agent、客户运行器及业务数据不因前端目录清理而退役。
