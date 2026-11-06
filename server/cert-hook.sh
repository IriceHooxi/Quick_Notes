#!/bin/sh
# 证书申请或续期成功后由 lego 调用（部署时也会手动调用一次）：把证书交给同步服务，并重启它
set -eu
. /etc/jian-sync/cert.env
src="/etc/jian-sync/lego/certificates/$CERT_DOMAIN"
install -d -m 750 -o root -g jian /etc/jian-sync/tls
install -m 644 -o root -g jian "$src.crt" /etc/jian-sync/tls/cert.pem
install -m 640 -o root -g jian "$src.key" /etc/jian-sync/tls/key.pem
systemctl try-restart jian-sync.service
