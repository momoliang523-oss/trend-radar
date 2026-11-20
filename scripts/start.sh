#!/bin/zsh
# 后台常驻启动脚本(launchd 用):开机自启 + 崩溃自动拉起
# 密钥全部存在 macOS 钥匙串,不落在任何文件里:
#   trend-radar-fxbaogao          发现报告 API Key
#   trend-radar-alipay-app-id     支付宝应用 APP_ID
#   trend-radar-alipay-app-private-key / -public-key 支付宝 RSA2 密钥对(带 PEM 头)
cd "$(dirname "$0")/.." || exit 1
export TREND_RADAR_ADMIN_EMAILS="you@example.com"   # 换成你自己的管理员邮箱
FXBAOGAO_API_KEY="$(/usr/bin/security find-generic-password -s trend-radar-fxbaogao -w 2>/dev/null)"
export FXBAOGAO_API_KEY
# 支付通道:当前为「线下转账 + 人工确认」(个体户注册签约后,把支付宝三项从钥匙串读回即可切真实支付)
# OFFLINE_PAY_INFO = 展示给客户的收款信息(多行);清空且无支付宝密钥时才降级 mock(仅限本地)
# 示例:换成自己的收款信息;清空则线下转账不可用
# export OFFLINE_PAY_INFO=$'收款方式:支付宝\n收款人:<你的姓名>\n账号:<你的收款账号>'
# 支付宝当面付(已签约后启用;密钥在钥匙串 trend-radar-alipay-*)
# ALIPAY_APP_ID="$(/usr/bin/security find-generic-password -s trend-radar-alipay-app-id -w 2>/dev/null)"
# ALIPAY_PRIVATE_KEY="$(/usr/bin/security find-generic-password -s trend-radar-alipay-app-private-key -w 2>/dev/null)"
# ALIPAY_PUBLIC_KEY="$(/usr/bin/security find-generic-password -s trend-radar-alipay-app-public-key -w 2>/dev/null)"
# export ALIPAY_APP_ID ALIPAY_PRIVATE_KEY ALIPAY_PUBLIC_KEY
# export ALIPAY_NOTIFY_URL="https://hot.ryomomo.top/api/pay/notify/alipay"
exec /opt/homebrew/bin/node --disable-warning=ExperimentalWarning server.js
