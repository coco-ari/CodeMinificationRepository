#!/bin/sh
# 维护窗口内停写后备份完整数据及原生状态；不删除历史备份。
set -eu
cd /opt/autoops
exec 9>/srv/autoops/backups/.backup.lock
flock -n 9 || { printf '%s\n' '已有备份任务运行'; exit 1; }
for service in gateway worker; do
  test -n "$(docker compose ps --status running -q "$service")" || {
    printf '%s\n' '服务未全部运行，请先核对状态，不自动启动未知状态的环境'; exit 1;
  }
done
umask 077
destination="/srv/autoops/backups/autoops-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$destination"
docker compose images --format json > "$destination/images.json"
docker compose stop -t 90 gateway
trap 'docker compose up -d' EXIT
docker compose stop -t 90 worker
tar -czf "$destination/data-and-config.tar.gz" -C / srv/autoops/data opt/autoops/compose.yaml opt/autoops/.env opt/autoops/secrets opt/autoops/nginx opt/autoops/scripts opt/autoops/README.md
tar -tzf "$destination/data-and-config.tar.gz" >/dev/null
(cd "$destination" && sha256sum data-and-config.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
printf '备份已完成：%s\n' "$destination"
