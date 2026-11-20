# 线上部署手册(出海热点雷达)

目标形态:Linux VPS(Ubuntu/Debian)+ systemd 常驻 + Caddy 反代 + LiteLLM 网关(与本地 Magpie 同款模型)+ 沿用本地 SQLite 数据。

## 一、服务器一次性初始化(在新 VPS 上跑,root)

```bash
# 1. Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v   # 必须 >= 22

# 2. Caddy(反代 + HTTPS)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/..' # 见 Caddy 官方安装文档
apt-get update && apt-get install -y caddy

# 3. 防火墙:只开 22 / 80 / 443
apt-get install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

## 二、LLM 网关(服务器上没有本机 Magpie,任选其一)

**方案 A(推荐):LiteLLM Docker** —— 直接把本机 `~/.litellm/config.yaml`(已配好 DeepSeek + OpenRouter key)传上去:

```bash
apt-get install -y docker.io
mkdir -p /opt/litellm && scp ~/.litellm/config.yaml root@服务器:/opt/litellm/
docker run -d --restart=always --name litellm -p 127.0.0.1:8740:4000 \
  -v /opt/litellm/config.yaml:/app/config.yaml \
  -e LITELLM_MASTER_KEY=你的master_key ghcr.io/berriai/litellm:main-latest
```

然后 env 里写(模型名与本地 LiteLLM 一致,不带前缀):

```
MAGPIE_BASE_URL=http://127.0.0.1:8740
MAGPIE_API_KEY=<LITELLM_MASTER_KEY>
LLM_MODEL_FREE=deepseek-flash
LLM_MODEL_MID=deepseek-v4-pro
LLM_MODEL_HIGH=typesafe/jev-router   # 或 OpenRouter 上任何可用模型
```

**方案 B:Magpie Docker**(如果它有官方镜像;否则本地把 providers.json 复制上去)。

验证:`curl -s http://127.0.0.1:8740/v1/models -H "Authorization: Bearer $KEY"` 或直接跑一次 `/v1/messages`。

## 三、部署应用

```bash
# 本机(Mac)上执行:
cd ~/trend-radar
SERVER=root@你的服务器IP ./deploy/deploy.sh
```

脚本会把代码 rsync 到 `/opt/trend-radar/app`、把 `data/trend-radar.db` 备份后传到 `/opt/trend-radar/data`,并重启 systemd 服务。

## 四、服务器上的密钥文件(只此一处,权限 600)

`/opt/trend-radar/app/deploy/env`(deploy.sh 首次会从 env.example 生成,然后手动填):

```
TREND_RADAR_ADMIN_EMAILS=you@example.com
FXBAOGAO_API_KEY=sk-...(发现报告 key)
ALIPAY_APP_ID=...
ALIPAY_PRIVATE_KEY=...(应用私钥,多行 PEM 用双引号包 \n)
ALIPAY_PUBLIC_KEY=...
ALIPAY_NOTIFY_URL=(有域名后再填)
MAGPIE_BASE_URL=...
MAGPIE_API_KEY=...
LLM_MODEL_FREE/MID/HIGH=...
```

改完:`systemctl restart trend-radar`。

## 五、域名与 HTTPS(可后补)

- 有域名:把 A 记录指到服务器 IP → Caddyfile 改成域名 → `systemctl reload caddy` 自动签发证书
- 无域名:HTTP 明文跑通流程,⚠️ 登录密码明文传输,仅限内部测试;支付宝当面付走「下单→轮询」不依赖回调,也能用

## 六、上线冒烟清单

1. `curl http://服务器/` 200,`/api/meta` 无 providers、无任何密钥字样
2. 注册新账号 → 送 100 积分 + 7 天试用
3. 选品页跑一次分析:SSE 正常、研报卡有数据(发现报告 key 生效)、Comtrade 柱图有数据、积分按档扣
4. 支付宝扫码 → 模拟支付确认到账(或真实支付 1 分钱走通)
5. 管理员账号登录可见运营数据/订单确认
6. `journalctl -u trend-radar -f` 无异常、无密钥泄漏

## 七、运维速查

```bash
systemctl restart trend-radar        # 重启(部署后)
journalctl -u trend-radar -n 100 -f  # 看日志
systemctl stop trend-radar           # 停
sqlite3 /opt/trend-radar/data/trend-radar.db   # 直查数据库
# 备份:tar czf /root/backups/tr-$(date +%F).tgz /opt/trend-radar/data /opt/trend-radar/app/deploy/env
```
