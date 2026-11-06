#!/usr/bin/env bash
# 把同步服务器部署（或更新）到一台 Debian / Ubuntu 服务器上：
#   server/deploy.sh root@服务器IP [证书域名]       证书域名默认就用这个 IP
# 做的事：构建手机网页版 → 上传到 /opt/jian-sync → 在服务器上运行 install.sh。
# 第一次部署之前要先准备好的，见 server/README.md。
set -euo pipefail
HOST="${1:?用法：server/deploy.sh root@服务器IP [证书域名]}"
DOMAIN="${2:-${HOST#*@}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "$ROOT/server/build_web.py" --out "$ROOT/dist/web"
tar -czf - --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' -C "$ROOT" syncmerge.py server/jian_sync.py server/install.sh server/cert-hook.sh server/systemd \
    -C "$ROOT/dist" web \
  | ssh "$HOST" 'install -d -m 755 /opt/jian-sync && tar -xzf - -C /opt/jian-sync --no-same-owner'
ssh "$HOST" "bash /opt/jian-sync/server/install.sh '$DOMAIN'" </dev/null
echo "已部署：https://$DOMAIN:8443"
