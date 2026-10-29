#!/usr/bin/env bash
set -euo pipefail
umask 077

center_url=''
registration_token=''
ca_file=''
agent_directory='/opt/cmr-agent'
while (($#)); do
  case "$1" in
    --url) center_url="${2:?缺少中心地址}"; shift 2 ;;
    --token) registration_token="${2:?缺少注册令牌}"; shift 2 ;;
    --ca-file) ca_file="${2:?缺少 CA 证书路径}"; shift 2 ;;
    --directory) agent_directory="${2:?缺少目录}"; shift 2 ;;
    *) printf '不支持的参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { printf '仅支持 Linux 服务器。\n' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { printf '需要 root 权限访问宿主机 Docker Socket。\n' >&2; exit 1; }
[[ "$center_url" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]] || { printf '中心地址必须是 HTTPS 源站。\n' >&2; exit 1; }
[[ "$registration_token" =~ ^[a-zA-Z0-9_-]{32,256}$ ]] || { printf '一次性注册令牌格式无效。\n' >&2; exit 1; }
[[ "$agent_directory" =~ ^/opt/cmr-agent(/[a-zA-Z0-9_-]+)?$ ]] || { printf '安装目录必须位于 /opt/cmr-agent。\n' >&2; exit 1; }
curl_options=()
agent_options=()
# 沿用宿主机已信任的 CA，使内网证书在下载器和 Agent 容器中保持一致。
if [[ -z "$ca_file" && -r /etc/ssl/certs/ca-certificates.crt ]]; then
  ca_file=/etc/ssl/certs/ca-certificates.crt
fi
if [[ -n "$ca_file" ]]; then
  [[ -f "$ca_file" && -r "$ca_file" ]] || { printf 'CA 证书文件不可读。\n' >&2; exit 1; }
  curl_options=(--cacert "$ca_file")
  agent_options=(--env "NODE_EXTRA_CA_CERTS=$agent_directory/center-ca.crt")
fi
command -v docker >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
docker version --format '{{.Server.Version}}' >/dev/null
docker compose version >/dev/null
[[ -S /var/run/docker.sock ]] || { printf '未找到 Docker Socket。\n' >&2; exit 1; }
if [[ -e "$agent_directory" ]]; then
  printf '目录已存在，拒绝覆盖 Agent 身份。升级请保留原目录并按文档替换镜像。\n' >&2
  exit 1
fi
if docker container inspect cmr-agent >/dev/null 2>&1; then
  printf '已有 cmr-agent 容器，拒绝覆盖。\n' >&2
  exit 1
fi
static_directory="${agent_directory}-static"
[[ ! -e "$static_directory" ]] || { printf '前端发布目录已存在，拒绝覆盖，请按文档保留挂载并升级。\n' >&2; exit 1; }
printf '即将安装 Agent：挂载宿主机 Docker Socket，具备管理宿主机容器的权限。管理范围仍受中心模式和资源归属检查约束。\n'
mkdir -m 700 "$agent_directory"
mkdir -m 755 "$static_directory"
printf '%s' "$static_directory" > "$static_directory/.cmr-static-root"
chmod 644 "$static_directory/.cmr-static-root"
temporary_directory=$(mktemp -d /tmp/cmr-agent-install.XXXXXX)
trap 'rm -rf -- "$temporary_directory"' EXIT
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "${curl_options[@]}" --max-time 300 "${center_url%/}/agent/bundle.tar.gz" -o "$temporary_directory/bundle.tar.gz"
# 压缩包来自已验证 TLS 的中心，仍检查路径，避免越出临时目录。
tar -tzf "$temporary_directory/bundle.tar.gz" | while IFS= read -r entry; do
  case "$entry" in /*|../*|*/../*|*/..) printf '安装包路径无效。\n' >&2; exit 1 ;; esac
done
mkdir "$temporary_directory/bundle"
tar -xzf "$temporary_directory/bundle.tar.gz" --no-same-owner -C "$temporary_directory/bundle"
docker build -t cmr-agent:local "$temporary_directory/bundle"
printf '%s' "$registration_token" > "$agent_directory/registration-token"
chmod 600 "$agent_directory/registration-token"
# 内部 CA 仅复制公开证书，供容器内 Node 验证中心 TLS；不关闭校验。
if [[ -n "$ca_file" ]]; then
  install -m 644 "$ca_file" "$agent_directory/center-ca.crt"
fi
docker run -d --name cmr-agent --restart unless-stopped --memory 256m --memory-swap 384m --cpus 0.5 --pids-limit 128 \
  --label io.cmr.component=agent \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$agent_directory,dst=$agent_directory" \
  --mount "type=bind,src=$static_directory,dst=$static_directory" \
  --mount type=bind,src=/proc,dst=/host/proc,readonly \
  --env "CMR_CENTER_URL=${center_url%/}" --env "CMR_AGENT_DIR=$agent_directory" \
  --env "CMR_REGISTRATION_TOKEN_FILE=$agent_directory/registration-token" \
  "${agent_options[@]}" \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 cmr-agent:local
printf 'Agent 已启动，请在中心查看接入状态。首次注册成功后一次性令牌会自动删除。\n'
