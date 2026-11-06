#!/usr/bin/env bash
# 在服务器上运行（由 deploy.sh 调用）：bash /opt/jian-sync/server/install.sh 证书域名或IP
# 可以重复运行：已经有的用户、目录、配置都会保留，只更新程序和 systemd 单元。
set -euo pipefail
DOMAIN="${1:?缺少证书域名或 IP}"
APP=/opt/jian-sync
ETC=/etc/jian-sync

id jian >/dev/null 2>&1 || useradd --system --home-dir /var/lib/jian-sync --no-create-home --shell /usr/sbin/nologin jian
install -d -m 700 -o jian -g jian /var/lib/jian-sync
install -d -m 755 "$ETC"
[[ -f "$ETC/cert.env" ]] || echo "CERT_DOMAIN=$DOMAIN" > "$ETC/cert.env"
chmod 755 "$APP/server/cert-hook.sh"

install -m 644 "$APP"/server/systemd/jian-sync.service "$APP"/server/systemd/jian-cert.service "$APP"/server/systemd/jian-cert.timer /etc/systemd/system/
systemctl daemon-reload

# 证书：还没有就先申请（需要 80 端口能从外面访问）；已经有了就把它交给同步服务
if [[ ! -f "$ETC/lego/certificates/$DOMAIN.crt" ]]; then
  systemctl start jian-cert.service
fi
[[ -f "$ETC/tls/cert.pem" ]] || "$APP/server/cert-hook.sh"
systemctl enable --now jian-cert.timer
systemctl enable jian-sync.service
systemctl restart jian-sync.service
sleep 1
systemctl is-active jian-sync.service
