# 静态部署夹具

此目录将 `test/docker-integration.mjs` 中的无依赖静态示例固定为可选择 Git 提交的源码，不依赖模拟 ZIP 或旧下载接口。

构建上下文选择本目录，构建目录 `.`，构建脚本 `build`，产物 `dist`。`npm ci` 使用已提交的空依赖锁文件；配置的 npm 版本仍必须与执行器要求一致。

```sh
npm ci --no-audit --no-fund
npm run build -- --version=v1
```

`--version=v2` 生成不同页面标记，用于验证再次发布与历史回退；`--fail-build` 触发确定的构建失败，验证当前站点继续可用。健康失败恢复通过该隔离目标的健康检查配置触发，不影响已有站点。
