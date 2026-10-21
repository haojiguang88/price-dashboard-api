# 千岛成交数据全自动抓取客户端（WAF 已绕过，实测 200）

## 用法
```
qdclient_linux_amd64 "<Bearer token>" [spId] [目标地址调试参数]
```
输出：HTTP 状态行 + 响应 JSON（data.tradeHistory[] = 成交记录）。

## 技术要点（复现配方）
1. **TLS 指纹**（utls ClientHelloSpec，字节级对齐千岛 X5/BoringSSL 栈）：
   - ciphers: 4867,4865,4866,52393,52392,49195,49199,49196,49200,49161,49171,49162,49172,156,157,47,53（ChaCha 优先）
   - extensions 顺序: SNI, ext_master_secret(0x17), renegotiation_info(0xff01), supported_groups(29,23,24), ec_point_formats(0), session_ticket, sig_algs(9个,末尾含sha1), key_share(仅X25519), psk_modes(dhe), supported_versions(1.3,1.2)
   - 无 ALPN、无 GREASE、HTTP/1.1
2. **29 个请求头全量复刻**（见 main.go hdrs，含 x-request-channel/device/utm_source、downloadchannel、x-echo-* 等冷门头，缺一即 405）
3. **RSA2 签名**：base64(RSA-SHA256(硬编码私钥, path+requestId+timestamp))，私钥在代码里（脱壳自 aj8.java，与线上逐字节验证一致）
4. token：Bearer JWT，3 天有效——但**成交接口实测不校验 token**（2026-10-21 实测：exp 已过期的 token、甚至 `Bearer garbage.invalid.token` 都返回 200 且数据正常，QD_OFFSET 翻页同样不受影响）。WAF 只认 TLS 指纹 + 29 头 + RSA2 签名

## 已知维护点
- `/airline` 接口会轮换签名私钥；当前硬编码兜底 key 可用，失效时需重提取（extract from app or capture）
- x-request-version / x-request-version-code 随 app 版本变（当前 6.65.0 / 1250）
- token 目前不用续期。若哪天接口开始校验（预期表现：200 但 code 非 0 / 401），App 侧有续期通道：POST /signin/login/refresh，body {"refreshToken","accessToken"}，返回 {accessToken, expiresIn, refreshToken}（已逆向，见 jadx EchoRefreshTokenManager / un8.java），到时抓一次 refreshToken 即可接入
- 风控：低频抓取（日百次级）实测无滑块；撞 6700001 需降频
