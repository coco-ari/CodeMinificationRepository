# T3 Code 上游来源与本地适配记录

此目录由 AutoOps 维护，不属于上游应用源码。固定来源为 `pingdotgg/t3code` 的 `v0.1.1` 提交 `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`，Git tree 为 `19bc1716027653cb24dede84c851f6d2211df86b`。

首次导入来自官方固定 SHA 归档，完整包含 28,439 个受版本管理的文件/符号链接，原始内容 330,801,215 字节。每个文件均核对官方 Git blob SHA-1 和大小，另计算 SHA-256；不是此前少量调研缓存的复制。上游根 LICENSE 完整保留，MIT 版权为 `Copyright (c) 2026 T3 Tools Inc.`。依赖、参考仓库和资产保留其自身许可证，根 MIT 不替代这些许可。

- `manifest.json`：导入来源、归档哈希、提交/树身份、文件数量和许可；记录导入时基线，不宣称以后仍未修改。
- `files.jsonl`：不可变的逐文件基线，包括 Git 模式、Git blob SHA-1、SHA-256 和大小。
- `upstream-commit.json`、`upstream-tree.json`：官方提交与完整递归树响应。
- `local-adaptations.json`：最近一次本地差异快照，可重新生成；不替换基线。
- `build-dependencies.json`：按官方 workspace package.json 静态计算的声明依赖闭包，**不是已经构建通过的证明**。

从 AutoOps 仓库根检查原始基线：

```sh
python3 scripts/t3-source-import.py verify --destination vendor/t3code
```

实施适配后，记录差异而不把预期适配当成导入损坏：

```sh
python3 scripts/t3-source-import.py verify --destination vendor/t3code --allow-adaptations --report vendor/t3code/.autoops-source/local-adaptations.json
```

该命令只读应用源码，绝不还原或覆盖本地修改。它仍校验基线 inventory 自身未被修改；忽略未跟踪的 node_modules、构建输出等生成目录，保留上游已跟踪测试 fixture 的核对。需要恢复上游内容时应另建目录重新导入，再人工审查差异，不向已适配目录执行覆盖导入。

完整官方归档保留了 `.repos/` 参考源码。它不在官方 workspace glob 内，当前生产源码中未找到依赖该目录的 import；仅参考仓库同步脚本显式使用该目录。后续如按批准的依赖闭包移出，应另外记录排除清单，不能修改原始 inventory 掩盖删减。两个嵌套 gitlink（distilled、floci）仅记录提交身份，GitHub 源码归档不展开其内容；当前未展开，也未当作已下载代码。未导入 `.git` 元数据、安装依赖或本次生成的构建产物。9 个、合计 801 字节的 upstream node_modules 路径文件是已跟踪测试 fixture，不是安装依赖。

构建需保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 的 catalog/overrides/patches 与配置/scripts 一起使用。源码根指定 Node `^24.13.1`、pnpm `11.10.0`，核心为 Effect `4.0.5`、Vite Plus `1.0.0`、React `19.3.0`。Web 声明构建/测试 workspace 闭包为 22 包；Server 与 Web 合并闭包为 26 包。Server 部分实际构建依赖在 devDependencies，不能仅安装 production dependencies。Server 使用 `node:sqlite`，并有 node-pty 等 native dependency；平台二进制/安装脚本需要由实际构建验证。

源码暂存不代表所有文件已被父仓库 Git 跟踪。上游故意跟踪的一些 fixture 可被通用 `.gitignore` 忽略，提交时应根据 inventory 精确检查这些路径，不能对整个 vendor 执行强制添加而把 node_modules/构建输出也加入。
