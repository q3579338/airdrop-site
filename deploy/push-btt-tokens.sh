#!/usr/bin/env bash
# 把本机 monitorbitcoin.py 里的 Telegram / PushPlus 令牌写进服务器的 /etc/btt-monitor.env,并重启 btt-monitor。
# 本机 Git Bash 运行:bash D:/CLAUDE/airdrop-site/deploy/push-btt-tokens.sh
# 令牌不会打印到屏幕;服务器上文件 root:root 600。
set -euo pipefail

SRCPY="${1:-D:/CLAUDE/autofish/monitorbitcoin.py}"
KEY=~/.earnfarm-deploy/earnfarm_deploy_key
HOST=root@172.96.9.5
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$SRCPY" ] || { echo "找不到 $SRCPY"; exit 1; }
TG=$(grep -oP '^API_TOKEN = "\K[^"]+' "$SRCPY" || true)
CHAT=$(grep -oP '^CHAT_ID = "\K[^"]+' "$SRCPY" || true)
PP=$(grep -oP '^PUSHPLUS_TOKEN = "\K[^"]+' "$SRCPY" || true)
[ -n "$TG" ] && [ -n "$CHAT" ] && [ -n "$PP" ] || { echo "从 $SRCPY 里没提取到三个令牌"; exit 1; }
echo "提取到令牌(长度 ${#TG}/${#CHAT}/${#PP}),写入服务器..."

sed -e "s|^BTT_TG_TOKEN=.*|BTT_TG_TOKEN=$TG|" \
    -e "s|^BTT_TG_CHAT=.*|BTT_TG_CHAT=$CHAT|" \
    -e "s|^BTT_PUSHPLUS_TOKEN=.*|BTT_PUSHPLUS_TOKEN=$PP|" \
    "$HERE/btt-monitor.env.example" \
  | ssh -i "$KEY" "$HOST" 'umask 077; cat > /etc/btt-monitor.env; chmod 600 /etc/btt-monitor.env; systemctl restart btt-monitor; sleep 3; journalctl -u btt-monitor -n 3 --no-pager -o cat'
echo "完成。日志里应看到「推送: TG=on 微信=on」。"
