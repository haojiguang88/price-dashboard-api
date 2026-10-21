#!/bin/bash
# 小鸽 userKey 刷新并推送到服务器。
# 任务中心每天 18:10 跑 xiaoge.py；本脚本须在运行前几分钟执行（密钥只有几十分钟有效期）。
# 依赖：本机 WMPFDebugger(62000) + xiaoge-keyd.js(63002) 在跑，且小鸽小程序处于打开状态。
set -u
resp=$(curl -s -m 30 http://127.0.0.1:63002/refresh-key)
if ! echo "$resp" | grep -q '"ok": true'; then
  echo "[push-key] refresh failed: $resp"
  osascript -e 'display notification "小鸽 userKey 刷新失败：小程序没在运行或调试服务断了" with title "price-dashboard" sound name "Basso"' 2>/dev/null
  exit 1
fi
if ! scp -q -o ConnectTimeout=10 /tmp/xg-userkey.json zeshi-server:/www/wwwroot/price-dashboard-api/secrets/xiaoge_userkey.json; then
  echo "[push-key] scp failed"
  osascript -e 'display notification "小鸽 userKey 推送服务器失败" with title "price-dashboard" sound name "Basso"' 2>/dev/null
  exit 1
fi
echo "[push-key] ok $(date '+%F %T')"
