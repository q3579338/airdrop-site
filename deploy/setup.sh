#!/usr/bin/env bash
# airdrop.satloot.com 一键安装/更新(幂等)。在服务器上以 root 运行:bash /opt/airdrop-site/deploy/setup.sh
# 做的事:建输出目录 → 装 nginx 站点 → 装 BTT 监控服务 → 装页面生成服务+定时器 → 立刻生成一次 → 自检。
set -euo pipefail

SRC=/opt/airdrop-site
OUT=/var/www/airdrop-satloot
SITE=airdrop.satloot.com
BTT_DIR=/var/lib/btt-monitor
BTT_ENV=/etc/btt-monitor.env

[ -f "$SRC/build.mjs" ] || { echo "缺 $SRC/build.mjs,先把项目放到 $SRC"; exit 1; }
command -v node >/dev/null || { echo "缺 node"; exit 1; }
command -v python3 >/dev/null || { echo "缺 python3"; exit 1; }
for f in /etc/ssl/certs/satloot-selfsigned.crt /etc/ssl/private/satloot-selfsigned.key; do
  [ -f "$f" ] || { echo "缺证书 $f(其它 satloot 站点都在用它)"; exit 1; }
done
id riskdesk >/dev/null 2>&1 || { echo "缺 riskdesk 用户(BTT 监控借它的 grok 登录态跑)"; exit 1; }

mkdir -p "$OUT"
chown www-data:www-data "$OUT"
chown -R root:root "$SRC"
chmod -R a+rX "$SRC"
sed -i 's/\r$//' "$SRC/build.mjs" "$SRC/btt/btt_monitor.py" "$SRC/celeb/celeb_monitor.py" "$SRC/nft/nft_monitor.py" "$SRC"/deploy/*

# ---- nginx ----
install -m 644 "$SRC/deploy/$SITE.nginx.conf" "/etc/nginx/sites-available/$SITE"
ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
nginx -t
systemctl reload nginx

# ---- BTT 监控(Python:requests + bs4 + 标准库 sqlite3) ----
if ! python3 -c "import bs4, requests" >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-bs4 python3-requests
fi
mkdir -p "$BTT_DIR"
chown riskdesk:riskdesk "$BTT_DIR"
chmod 755 "$BTT_DIR"
if [ ! -f "$BTT_ENV" ]; then
  install -m 600 -o root -g root "$SRC/deploy/btt-monitor.env.example" "$BTT_ENV"
  echo "!! 已生成 $BTT_ENV 模板(令牌为空 = 不推送),填好后 systemctl restart btt-monitor"
fi
install -m 644 "$SRC/deploy/btt-monitor.service" /etc/systemd/system/btt-monitor.service

# ---- 名人发币监控(Python:requests + 标准库;推送令牌沿用 /etc/btt-monitor.env) ----
CELEB_DIR=/var/lib/celeb-monitor
mkdir -p "$CELEB_DIR"
chown riskdesk:riskdesk "$CELEB_DIR"
chmod 755 "$CELEB_DIR"
if [ ! -f /etc/celeb-monitor.env ]; then
  install -m 600 -o root -g root "$SRC/deploy/celeb-monitor.env.example" /etc/celeb-monitor.env
fi
install -m 644 "$SRC/deploy/celeb-monitor.service" /etc/systemd/system/celeb-monitor.service

# ---- NFT 打新追踪(Python:requests + 标准库;grok 联网;推送令牌沿用 /etc/btt-monitor.env) ----
NFT_DIR=/var/lib/nft-monitor
mkdir -p "$NFT_DIR"
chown riskdesk:riskdesk "$NFT_DIR"
chmod 755 "$NFT_DIR"
install -m 644 "$SRC/deploy/nft-monitor.service" /etc/systemd/system/nft-monitor.service

# ---- 页面生成 ----
install -m 644 "$SRC/deploy/airdrop-site.service" /etc/systemd/system/airdrop-site.service
install -m 644 "$SRC/deploy/airdrop-site.timer" /etc/systemd/system/airdrop-site.timer
systemctl daemon-reload
systemctl enable --now btt-monitor.service
systemctl restart btt-monitor.service
systemctl enable --now celeb-monitor.service
systemctl restart celeb-monitor.service
systemctl enable --now nft-monitor.service
systemctl restart nft-monitor.service
systemctl enable --now airdrop-site.timer
sleep 3
systemctl start airdrop-site.service

echo "== 自检"
ls -la "$OUT" "$OUT/btt" "$OUT/celeb" "$OUT/en" "$OUT/en/btt" "$OUT/en/celeb" 2>/dev/null || true
code=$(curl -sk -o /tmp/airdrop-check.html -w '%{http_code}' -H "Host: $SITE" https://127.0.0.1/)
echo "https://127.0.0.1/ (Host: $SITE) → $code"
grep -o '<title>[^<]*</title>' /tmp/airdrop-check.html || true
grep -c 'class="card"' /tmp/airdrop-check.html | sed 's/^/空投卡片数: /'
code=$(curl -sk -o /tmp/airdrop-check-btt.html -w '%{http_code}' -H "Host: $SITE" https://127.0.0.1/btt/)
echo "https://127.0.0.1/btt/ (Host: $SITE) → $code"
grep -c 'class="card"' /tmp/airdrop-check-btt.html | sed 's/^/BTT 卡片数: /'
code=$(curl -sk -o /tmp/airdrop-check-celeb.html -w '%{http_code}' -H "Host: $SITE" https://127.0.0.1/celeb/)
echo "https://127.0.0.1/celeb/ (Host: $SITE) → $code"
grep -c 'class="card"' /tmp/airdrop-check-celeb.html | sed 's/^/名人发币卡片数: /'
code=$(curl -sk -o /tmp/airdrop-check-nft.html -w '%{http_code}' -H "Host: $SITE" https://127.0.0.1/nft/)
echo "https://127.0.0.1/nft/ (Host: $SITE) → $code"
grep -c 'class="card"' /tmp/airdrop-check-nft.html | sed 's/^/NFT 卡片数: /'
for p in /en/ /en/btt/ /en/celeb/ /en/nft/; do
  code=$(curl -sk -o /tmp/airdrop-check-en.html -w '%{http_code}' -H "Host: $SITE" "https://127.0.0.1$p")
  echo "https://127.0.0.1$p (Host: $SITE) → $code $(grep -o '<html lang="[^"]*"' /tmp/airdrop-check-en.html)"
done
systemctl is-active btt-monitor.service | sed 's/^/btt-monitor: /'
journalctl -u btt-monitor -n 5 --no-pager -o cat
systemctl is-active celeb-monitor.service | sed 's/^/celeb-monitor: /'
journalctl -u celeb-monitor -n 8 --no-pager -o cat
systemctl is-active nft-monitor.service | sed 's/^/nft-monitor: /'
journalctl -u nft-monitor -n 8 --no-pager -o cat
systemctl list-timers airdrop-site.timer --no-pager | head -2
echo "== 完成"
