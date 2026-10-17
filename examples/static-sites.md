# 前端静态站点部署

支持 Vue、React 等生成 `index.html` 与静态资源的项目。前端与后端共用已有的 Docker Nginx：Agent 只使用临时 Node 构建容器，发布完成后删除构建容器，不新建长期运行的 Web 容器，不修改或重启共用 Nginx。不包含 Next.js/Nuxt SSR、域名申请和证书管理。

## 首次配置

1. 在项目中新增服务，类型选择“前端静态站点”，填写包含 `package.json` 的项目目录。为测试、生产分别关联仓库和分支。
2. 新增平台管理的部署目标，选择服务器。设置 Node 构建镜像、包管理器、构建脚本、产物目录和站点访问地址。产物目录相对仓库根，例如 `dist`、`build`、`frontend/dist`。
3. 保存后获得部署目标 ID。将下述目录挂载和站点配置添加到现有 Nginx。此操作由运维执行一次，不由平台自动接管。
4. 确认 Agent 能访问站点域名、Docker 镜像仓库及 npm 依赖源，之后在服务上发布。

默认构建镜像为 `node:24-bookworm-slim`。npm 使用 `npm ci --include=dev`，必须提交 `package-lock.json`；pnpm 使用指定准确版本及 `--frozen-lockfile`，必须提交 `pnpm-lock.yaml`。依赖锁文件必须位于所选项目目录中；使用仓库根锁文件的 monorepo 应选择根目录，并在根 `package.json` 中提供构建对应子项目的脚本。暂不支持 Yarn。

pnpm 默认版本 `10.11.0` 可以在部署目标中调整；如果 `package.json` 声明了 `packageManager`，必须保持一致。构建脚本填写 `build` 或 `build:test` 等脚本名称，附加参数按行填写，例如 `--mode`、`test`。测试和生产的构建配置分别保存在部署目标中；源码仍按环境与服务选择。公开 registry 地址可以通过仓库的 `.npmrc` 配置，不要提交私有包访问令牌。

## 给现有 Nginx 挂载目录

默认 Agent 数据目录为 `/opt/cmr-agent`，公共静态产物目录为它的同级目录 `/opt/cmr-agent-static`。新安装脚本会创建并挂载后者；自定义 Agent 目录时，静态目录为该路径加 `-static`。

在已有 Nginx 的 Compose 服务中增加只读挂载，保留原有配置、网络、证书及后端转发：

```yaml
services:
  nginx:
    # 原有 image、ports、networks 等保持原配置。
    volumes:
      - /opt/cmr-agent-static:/srv/cmr-sites:ro
```

必须挂载整个静态根目录，不能直接挂载 `current` 符号链接或某个具体版本目录，否则 Docker 可能一直提供旧目录。增加挂载需要由运维重新创建该 Nginx 容器一次；以后的前端发布无需重新创建或重启它。

在站点配置中使用保存目标后生成的 ID 替换 `TARGET_ID`：

```nginx
server {
    # listen、server_name、证书等使用现有配置。
    root /srv/cmr-sites/TARGET_ID/current;
    index index.html;
    open_file_cache off;

    location = /__cmr_release.txt {
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 保留原来的 /api/ 等后端转发规则。
}
```

示例为站点根路径部署；子路径部署需要同时匹配前端构建的 base/publicPath、Nginx 的 root/alias 和 SPA 回退位置。发布验证地址填写实际站点根，例如 `https://app.example.com/` 或 `https://example.com/admin/`，不能填写某个业务页面。Agent 容器内的 `127.0.0.1` 指向 Agent 自己，因此应填写可从 Agent 到达的站点域名或已配置好的内网入口。

Nginx 必须允许读取目录中的相对符号链接。配置校验通过后由运维加载配置。平台不会自动修改已有后端 location、处理证书或接管 Nginx。

## 升级已有 Agent

旧 Agent 不声明 `static-site-v1`，中心会拒绝向它创建前端发布任务；Java 发布保持兼容。新 Agent 为 `1.1.0`。按 Agent 升级流程保留原有身份、工作目录和所有挂载，并额外准备：

```bash
sudo install -d -m 755 /opt/cmr-agent-static
printf '%s' '/opt/cmr-agent-static' | sudo tee /opt/cmr-agent-static/.cmr-static-root >/dev/null
sudo chmod 644 /opt/cmr-agent-static/.cmr-static-root
```

启动替换后的 Agent 容器时增加：

```text
--mount type=bind,src=/opt/cmr-agent-static,dst=/opt/cmr-agent-static
```

不得删除 Agent 数据目录重新注册，也不要让 Nginx 读取 Agent 身份目录。标记文件用于在发布前发现缺少静态目录挂载的情况。完整备份和恢复应包括 Agent 私有数据目录与公共静态目录，两者需来自同一时间点。

## 发布、验证和回滚

中心固定源码及配置；Agent 下载 ZIP，在无 Docker Socket 的临时 Node 容器中安装锁定依赖并执行构建。只复制指定输出目录，拒绝符号链接、隐藏文件、`node_modules`、包含 `package.json` 的源码目录和缺失的 `index.html`，输出上限为 512 MiB、100000 个目录项。构建镜像、依赖源不可访问或构建失败时，当前站点保持不变。

产物布局：

```text
/opt/cmr-agent-static/TARGET_ID/
  releases/RELEASE_ID/index.html
  releases/RELEASE_ID/__cmr_release.txt
  current -> releases/RELEASE_ID
```

构建成功后原子替换 `current` 指针，再从站点地址读取版本标识和首页。两者必须返回 HTTP 200，版本标识必须匹配本次任务，首页可额外检查指定内容。验证标识及首页应绕过 CDN/代理缓存；Agent 不会清理外部 CDN 缓存。

验证失败时恢复上一成功版本及其验证配置；首次失败则移除本次当前指针。默认只保留成功发布链最后两个节点对应的静态产物。手动回退优先使用本机目录，缺失则从中心原 ZIP 按历史配置重建，不重新拉取分支，也不重启共用 Nginx；成功后新增发布节点。中心档案与本机保留数量独立，具体见 [存储策略](storage-policy-20261017.md)。前端没有单独“重启”操作。

版本目录切换是原子的，但不保证多个浏览器请求属于同一版本；建议构建资源使用内容哈希，HTML 不长期缓存。已打开旧页面的浏览器仍可能请求旧资源，需结合应用自身的更新提示或 CDN 资源保留策略处理。前端构建环境变量会进入浏览器资源，不能用于保存数据库密码等服务端秘密。

## 验证范围

自动测试覆盖 Node 构建参数与锁文件策略、目录归属、错误产物、当前版本切换、真实 HTTP 版本检查、首次失败、自动和手动回滚、Agent 恢复、共用 Nginx 不被操作、旧 Agent 能力限制及 Java 回归。单元测试中的 Docker 执行由替身模拟，不能代替实际 Node 镜像、挂载权限与 Nginx 的 Docker 集成验收；上线前需在隔离 Docker 环境补做完整验证。

`pnpm run test:docker` 已加入真实 Node 构建及共用 Nginx 场景：同一个 Nginx 提供前端并转发 Java API，检查两次发布、手动回滚、构建失败、页面验证失败自动回滚，并断言 Nginx 与后端容器 ID、启动时间保持不变。可通过 `CMR_IT_NODE_IMAGE`、`CMR_IT_NGINX_IMAGE` 指定测试镜像。2026-10-15 的本地环境没有 Docker，此新增场景尚未执行。
