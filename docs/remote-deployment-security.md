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
2. 反向代理接入真实的服务端认证，例如 OIDC、Authelia、Cloudflare Access 或受控的服务器 Basic Auth。
3. 认证成功后，反向代理先删除客户端传来的身份头，再写入由认证层生成的身份头。
4. API 使用 `SERVER_AUTH_MODE=trusted_reverse_proxy`，并要求该身份头存在。
5. API 端口不对公网开放，`TRUST_PROXY` 只信任 loopback。

示例环境：

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=remote
HOST=127.0.0.1
PORT=3001
PUBLIC_BASE_URL=https://business.example.com
TRUST_PROXY=loopback
SERVER_AUTH_MODE=trusted_reverse_proxy
AUTH_IDENTITY_HEADER=X-Authenticated-User
CORS_ORIGINS=https://business.example.com
```

反向代理必须用认证上游产生的变量覆盖身份头，不能引用或透传客户端的同名头：

```nginx
# $authenticated_user 必须只由 auth_request / OIDC 认证结果赋值。
proxy_set_header X-Authenticated-User $authenticated_user;
proxy_set_header X-Forwarded-Proto https;
proxy_pass http://127.0.0.1:3001;
```

当前代码只定义并强制执行上述“受信反向代理身份”契约，不擅自创建用户、密码或登录页面。认证产品和账号体系需要单独确认后再落地。

## 明确禁止

- 不把 API Token、固定密钥或“万能密码”打进前端包。
- 不用 CORS 代替认证。
- 不直接暴露 `3001` 端口。
- 不在 HTTP 上发送登录凭据。
