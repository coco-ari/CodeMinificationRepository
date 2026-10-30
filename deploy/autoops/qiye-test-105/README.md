# 企业版测试服务器 Agent

目标为 `root@47.102.123.105:22`，CentOS Linux 7、x86_64，内核 `3.10.0-1062.1.2.el7.x86_64`。密码不记录在仓库。2026-10-30 用户明确授权登录并安装 Docker、Compose 和部署 Agent；未执行 Java 业务迁移。

## 当前安装

2026-10-30 23:05（北京时间）完成验证。平台节点沿用用户已创建的“企业版-测试”，ID `08cf510e-4362-4349-beaa-c38c7dfa3e7b`，接入 `https://auto.996788.xyz`，版本 `1.6.2`、在线、声明 `env-file-v1`，存储策略已应用。当前未分配项目或环境。

| 项目 | 实际值 |
| --- | --- |
| 宿主机 Docker Engine／CLI | `26.1.4`，服务已启用开机启动 |
| 宿主机 Compose／Buildx | `2.27.1`／`0.14.1` |
| Agent 容器／镜像 | `cmr-agent`／`cmr-agent:local` |
| Agent 镜像 ID | `sha256:9ad815c7beea88d47fd509e03b115b04d176385180b290d346bb676454c33c0b` |
| Agent 内 Node／Docker CLI／Compose | `24.22.2`／`29.9.0`／`5.6.0`，已验证访问宿主机 Docker 26.1.4 |
| Agent 资源 | 内存 256 MiB、交换总额 384 MiB、CPU 0.5、PID 128 |
| Agent 重启及日志 | `unless-stopped`；每份 10 MiB、最多 3 份 |
| Docker 默认桥接及地址池 | `10.253.0.1/24`；`10.253.0.0/16` 按 `/24` 分配，避开宿主机原 `172.17.176.0/20` 路由 |

安装包 SHA256 为 `5827bb489c49b0be522f3108894b45cb05762bb64a4ebc8a589aa2b397236ac9`；运行容器内 21 个程序文件与该包逐文件一致。只为本次镜像构建调整 Alpine 软件包下载 URL，签名检查保留，Java 和 Agent 程序未修改；构建适配文件及原安装器在下表的引导目录内保存。

| 路径 | 用途 |
| --- | --- |
| `/opt/cmr-agent` | 持久身份、任务和状态；目录 0700、身份文件 0600，升级时保留 |
| `/opt/cmr-agent/env-files` | 已准备的业务环境文件目录，0700；具体文件使用 0600，本次未填入业务变量 |
| `/opt/cmr-agent-static` | 标准静态发布目录及归属标记 |
| `/opt/cmr-agent/center-ca.crt` | 从 CentOS 系统证书包复制的公开 CA，供 Agent TLS 使用 |
| `/opt/cmr-agent-bootstrap-20261030` | 安装日志、固定摘要、网络适配、前后健康与身份恢复验证，目录 0700 |

标准挂载为同路径 Agent／静态目录、Docker Socket 和只读 `/proc → /host/proc`，Agent 不发布入站端口。专属平台构建器为 `buildx_buildkit_cmr-08cf510e-4362-4349-beaa-c38c7dfa3e7b0`；运行镜像 ID 为 `sha256:260cc297a47c57183fe53fb963885068c30e976060fabc90e32af04919dbd0bf`，对应预置 BuildKit 摘要 `sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528`。保留 2 个成功版本、专用构建缓存 2 GiB；实际空缓存为 0，策略状态 `applied`。

## CentOS 7 安装差异

- CentOS 归档源返回 403，Docker 官方源在 Yum 中连接重置；本次通过阿里云归档镜像安装固定 RPM，保持 GPG 检查，并核对 Docker 发布公钥指纹 `060A61C51B558A7F742B77AAC52FEB6B621E9F35`。独立 Yum 配置保存在引导目录，没有覆盖原有 Yum 源。
- CentOS 的系统证书包为 `/etc/pki/tls/certs/ca-bundle.crt`。首次安装使用安装器已有参数 `--ca-file /etc/pki/tls/certs/ca-bundle.crt`，避免缺少 Ubuntu 证书路径时旧 Bash 对空数组的错误；TLS 校验始终开启。已有身份时按标准升级流程保留目录，不能重复运行首次安装器。
- 基础镜像经 DaoCloud 单次拉取，并核对官方摘要：Node amd64 为 `sha256:4eefa1bfce4197942661ef9148247d779ddf1bb0ee006d3294a467609de60724`，Docker CLI amd64 为 `sha256:4caa52207e95c68c3087006eefb3a5f6ca48ad1c0ba3aa3e6843549a0720b7bb`。来源分别为 [Node 官方镜像记录](https://github.com/docker-library/repo-info/blob/master/repos/node/remote/24-alpine.md)、[Docker CLI 官方镜像记录](https://github.com/docker-library/repo-info/blob/master/repos/docker/remote/29-cli.md)。BuildKit 使用官方 Docker Hub 查询到的固定摘要预置，没有采用被拒绝的浮动镜像下载。
- Alpine 原源实测约 30 KB/s，阿里云镜像约 950 KB/s。单次构建文件只将 `/etc/apk/repositories` 中的下载地址改为 `https://mirrors.aliyun.com/alpine/`；51 项依赖在约 21 秒内安装完成，原安装器和适配摘要保留在引导目录。
- 自动审批拒绝了持久 Docker 全局镜像源配置及未固定摘要的 BuildKit 预取。实际采用固定摘要的单次拉取，`/etc/docker/daemon.json` 没有 `registry-mirrors`。Docker Hub 直连测试超时，后续业务发布仍须准备可访问且固定的 Maven／JRE／Node 等镜像来源；本次未替业务发布修改全局配置。

## 验证和后续操作

平台注册及持续心跳正常，首次口令文件已自动删除。实际重启 Agent 后，节点 ID、注册时间与中心地址保持，重新心跳及存储策略正常。用虚构环境文件验证 Agent 能读取 `/opt/cmr-agent/env-files`，容器内原生 Compose 解析通过；测试文件已删除。

安装前后，communication、api、manage、assistant、reward 的本机 `swagger-resources` 均返回 200，五个 Java PID 及原 Nginx、MySQL、Redis、FastDFS PID 保持。未启停或迁移这些业务进程，未重启宿主机；该检查不代替支付、设备等完整业务验收。

后续从工作台分配该节点到对应项目／环境，按实际业务填写 `env-files` 中的文件，并在 Java 配置中引用绝对路径。Profile 与包内 YAML、日志卷及压缩边界见 [环境文件部署记录](../../../docs/validation/deployment-env-file.md)。

```sh
sudo docker ps --filter name=cmr-agent
sudo docker logs --tail 50 cmr-agent
sudo docker exec cmr-agent docker version
```
