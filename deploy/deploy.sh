#!/bin/zsh
# 一键部署:本机 rsync 代码+数据到服务器并重启服务
# 用法:SERVER=root@1.2.3.4 ./deploy/deploy.sh [skipdata]
#   skipdata = 只传代码不传数据库(如只想更新前端)
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER="${SERVER:?用法: SERVER=root@服务器IP ./deploy/deploy.sh [skipdata]}"
REMOTE_APP=/opt/trend-radar/app
REMOTE_DATA=/opt/trend-radar/data

echo "==> 目标: $SERVER"

# 1. 服务器目录骨架 + 服务文件(幂等)
ssh "$SERVER" "mkdir -p $REMOTE_APP $REMOTE_DATA /opt/trend-radar/logs \
  && [ -f /etc/systemd/system/trend-radar.service ] || echo '(首次部署时请手动: cp $REMOTE_APP/deploy/trend-radar.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now trend-radar)'"

# 2. 同步代码(排除本地数据/日志/密钥文件)
rsync -az --delete \
  --exclude 'data/' --exclude 'data.db' --exclude 'tr.db' --exclude 'trend.db' --exclude 'trend-radar.db' \
  --exclude 'app.db' --exclude '.DS_Store' --exclude 'deploy/env' \
  ./ "$SERVER:$REMOTE_APP/"

# 3. env 文件首次生成(不覆盖服务器上已填的)
ssh "$SERVER" "[ -f $REMOTE_APP/deploy/env ] || { cp $REMOTE_APP/deploy/env.example $REMOTE_APP/deploy/env; chmod 600 $REMOTE_APP/deploy/env; echo '==> 已生成 env 模板,请先编辑服务器上的 $REMOTE_APP/deploy/env 再启动!'; }"

# 4. 同步数据库(除非 skipdata)
if [[ "${1:-}" != "skipdata" ]]; then
  local_tmp=$(mktemp /tmp/tr-db.XXXXXX.db)
  # WAL 一致性备份(服务在跑也能安全拷)
  sqlite3 data/trend-radar.db ".backup '$local_tmp'"
  rsync -az "$local_tmp" "$SERVER:$REMOTE_DATA/trend-radar.db"
  rm -f "$local_tmp"
  echo "==> 数据库已同步"
fi

# 5. 重启服务(装了 systemd unit 之后才有效;首次部署会提示)
ssh "$SERVER" "systemctl restart trend-radar 2>/dev/null && echo '==> 服务已重启' || echo '==> (systemd 尚未配置,跳过重启)'"
echo "==> 完成。冒烟: curl -s http://$SERVER:80/ | head -c 200"
