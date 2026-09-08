#!/usr/bin/env bash
# airdrop.satloot.com 一键安装/更新(幂等)。在服务器上以 root 运行:bash /opt/airdrop-site/deploy/setup.sh
# 做的事:建输出目录 → 装 nginx 站点 → 装 systemd 服务+定时器 → 立刻生成一次 → 自检。
set -euo pipefail

SRC=/opt/airdrop-site
OUT=/var/www/airdrop-satloot
SITE=airdrop.satloot.com

[ -f "$SRC/build.mjs" ] || { echo "缺 $SRC/build.mjs,先把项目放到 $SRC"; exit 1; }
command -v node >/dev/null || { echo "缺 node"; exit 1; }
for f in /etc/ssl/certs/satloot-selfsigned.crt /etc/ssl/private/satloot-selfsigned.key; do
  [ -f "$f" ] || { echo "缺证书 $f(其它 satloot 站点都在用它)"; exit 1; }
done

mkdir -p "$OUT"
chown www-data:www-data "$OUT"
chown -R root:root "$SRC"
chmod -R a+rX "$SRC"

install -m 644 "$SRC/deploy/$SITE.nginx.conf" "/etc/nginx/sites-available/$SITE"
ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
nginx -t
systemctl reload nginx

install -m 644 "$SRC/deploy/airdrop-site.service" /etc/systemd/system/airdrop-site.service
install -m 644 "$SRC/deploy/airdrop-site.timer" /etc/systemd/system/airdrop-site.timer
systemctl daemon-reload
systemctl enable --now airdrop-site.timer
systemctl start airdrop-site.service

echo "== 自检"
ls -la "$OUT"
code=$(curl -sk -o /tmp/airdrop-check.html -w '%{http_code}' -H "Host: $SITE" https://127.0.0.1/)
echo "https://127.0.0.1/ (Host: $SITE) → $code"
grep -o '<title>[^<]*</title>' /tmp/airdrop-check.html || true
grep -c 'class="card"' /tmp/airdrop-check.html | sed 's/^/卡片数: /'
systemctl list-timers airdrop-site.timer --no-pager
echo "== 完成。DNS:在 Cloudflare 给 $SITE 加 A 记录 → 本机公网 IP,橙云代理(与 earn.satloot.com 相同)。"
