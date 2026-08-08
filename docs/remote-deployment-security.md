# 生意系统部署安全边界

## 纯本机模式

- `DEPLOYMENT_MODE=local`
- `HOST=127.0.0.1`（默认值）
- 前端和 API 仅在本机访问。
- 不需要把任何固定密钥写入前端。

开发环境只有显式设置非 loopback `HOST` 才会开放监听，并会输出警告。生产环境禁止直接监听非 loopback 地址。

## 远程部署模式

远程部署不是把 API 直接监听到公网。API 仍然必须绑定 `127.0.0.1`，公网边界由同机 HTTPS 反向代理承担：

1. 反向代理终止 TLS，公网只开放 HTTPS。
2. API 端口不对公网开放，`TRUST_PROXY` 只信任 loopback。
3. 单用户部署使用服务端会话认证；账号、密码哈希和会话密钥只存放在后端环境变量。
4. 登录成功后由后端签发 `HttpOnly + Secure + SameSite=Strict` Cookie，前端不保存密码或固定 Token。
5. 如以后接入 OIDC、Authelia 或 Cloudflare Access，可切换回受信反向代理身份模式。

### 单用户会话模式

生成密码哈希和会话密钥：

```bash
cd /www/wwwroot/price-dashboard-api
npm run auth:hash-password
openssl rand -hex 32
```

生产环境示例：

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=remote
HOST=127.0.0.1
PORT=3001
PUBLIC_BASE_URL=https://business.example.com
TRUST_PROXY=loopback
SERVER_AUTH_MODE=session
AUTH_USERNAME=owner
AUTH_PASSWORD_HASH=scrypt-v1:generated-salt:generated-hash
AUTH_SESSION_SECRET=generated-random-secret
AUTH_SESSION_TTL_HOURS=12
CORS_ORIGINS=https://business.example.com
```

这三个认证变量缺失或格式错误时，生产后端会直接启动失败。

会话模式下的 Nginx `/api` 代理至少保留以下请求信息：

```nginx
location /api/ {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://127.0.0.1:3001;
}
```

### 受信反向代理模式

使用外部认证产品时配置：

```dotenv
SERVER_AUTH_MODE=trusted_reverse_proxy
AUTH_IDENTITY_HEADER=X-Authenticated-User
AUTH_PROXY_SHARED_SECRET=replace-with-at-least-32-random-characters
# optional override; default is X-Price-Dashboard-Proxy-Secret
# AUTH_PROXY_SECRET_HEADER=X-Price-Dashboard-Proxy-Secret
```

反向代理必须：
1. 用认证上游产生的变量覆盖身份头，不能引用或透传客户端的同名头；
2. 注入仅 nginx 知道的共享密钥头（客户端伪造身份头时仍无法通过）。

```nginx
# $authenticated_user 必须只由 auth_request / OIDC 认证结果赋值。
proxy_set_header X-Authenticated-User $authenticated_user;
proxy_set_header X-Price-Dashboard-Proxy-Secret "<same value as AUTH_PROXY_SHARED_SECRET>";
proxy_set_header X-Forwarded-Proto https;
proxy_pass http://127.0.0.1:3001;
```

## 明确禁止

- 不把 API Token、固定密钥或“万能密码”打进前端包。
- 不把明文密码提交到 Git。
- 不用 CORS 代替认证。
- 不直接暴露 `3001` 端口。
- 不在 HTTP 上发送登录凭据。
