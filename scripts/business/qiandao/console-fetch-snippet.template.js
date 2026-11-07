/**
 * 千岛成交记录：只在微信 DevTools Console 里跑。
 * 由 export_spu_list.py 生成，SPU 列表嵌在下面。
 * 粘贴后不会发请求。换号后填 token，再手动 startQiandaoTrades()。
 */
let QIANGDAO_TOKEN = "";
let QIANGDAO_REFRESH_TOKEN = "";
const QIANGDAO_DEVICE_ID = "75c6ac45-6a3f-4760-95cc-77a2de1dde9a";
const QIANGDAO_SKEY = "8eVqsqhBdEKxeULQ1M72yrZB5HET9fx0";
const QIANGDAO_INTERVAL_MS = 15000;
const QIANGDAO_SPUS = __SPU_LIST_JSON__;

const QIANGDAO_PATH = "/c2c-web/v1/common/get-spu-trading-history-list";
const QIANGDAO_REFRESH_PATH = "/signin/login/refresh";
const QIANGDAO_URL = "https://api.qiandao.cn" + QIANGDAO_PATH;

function qiandaoBytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function qiandaoSign(path, timestamp) {
  const message = path + String(timestamp);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(QIANGDAO_SKEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(qiandaoBytesToHex(digest));
}

function qiandaoSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qiandaoState() {
  if (!window.__QIANGDAO_STATE) {
    window.__QIANGDAO_STATE = {
      items: [],
      doneSpuIds: [],
      stopped: null,
      started_at: null
    };
  }
  return window.__QIANGDAO_STATE;
}

function qiandaoIsCaptcha(payload, status) {
  const text = JSON.stringify(payload || {});
  return status === 6700001 || text.includes("6700001") || text.includes("滑块");
}

function qiandaoAuthHeaders(sign, timestamp, token) {
  return {
    "Content-Type": "application/json",
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "X-Request-Sign": sign,
    "X-Request-Timestamp": String(timestamp),
    "X-Request-Sign-Version": "v1",
    "X-Request-Sign-Type": "HMAC_SHA256",
    "X-Request-Package-Sign-Version": "0.0.2",
    "X-Request-Version": "2.150.61",
    "X-Device-Id": QIANGDAO_DEVICE_ID,
    "X-Package-Id": "1000",
    "X-Request-Package-Id": "1000",
    "X-Request-Circle": "chaowanzu"
  };
}

async function qiandaoRefresh() {
  const refreshToken = String(QIANGDAO_REFRESH_TOKEN || "").trim();
  const accessToken = String(QIANGDAO_TOKEN || "").replace(/^Bearer\s+/i, "").trim();
  if (!refreshToken || !accessToken) {
    console.log("续期需要同时有 QIANGDAO_TOKEN 和 QIANGDAO_REFRESH_TOKEN");
    return false;
  }
  const timestamp = Date.now();
  const sign = await qiandaoSign(QIANGDAO_REFRESH_PATH, timestamp);
  const response = await fetch("https://api.qiandao.cn" + QIANGDAO_REFRESH_PATH, {
    method: "POST",
    headers: qiandaoAuthHeaders(sign, timestamp, accessToken),
    body: JSON.stringify({ refreshToken, accessToken })
  });
  const payload = await response.json().catch(() => ({}));
  const data = payload.data || payload;
  if (!response.ok || !data.accessToken || !data.refreshToken) {
    console.log("续期失败，停住。不要连续重试。", payload);
    return false;
  }
  QIANGDAO_TOKEN = data.accessToken;
  QIANGDAO_REFRESH_TOKEN = data.refreshToken;
  const expiresIn = Number(data.expiresIn || 0);
  console.log(`续期成功，access 大约 ${Math.round(expiresIn / 3600)} 小时。把新的两个 token 留在这个 Console 里。`);
  return true;
}

async function qiandaoFetchPage(spu, offset) {
  const timestamp = Date.now();
  const sign = await qiandaoSign(QIANGDAO_PATH, timestamp);
  const token = String(QIANGDAO_TOKEN || "").trim();
  const response = await fetch(QIANGDAO_URL, {
    method: "POST",
    headers: qiandaoAuthHeaders(sign, timestamp, token),
    body: JSON.stringify({
      spuId: String(spu.spu_id),
      tradingType: "EXCHANGE",
      limit: 20,
      specIds: [],
      offset
    })
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function qiandaoDownload() {
  const state = qiandaoState();
  const blob = new Blob([JSON.stringify({
    captured_at: new Date().toISOString(),
    device_id: QIANGDAO_DEVICE_ID,
    stopped: state.stopped,
    items: state.items
  }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "qiandao-trading-history.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function startQiandaoTrades(options = {}) {
  const pages = Math.max(1, Number(options.pages || 1));
  if (!String(QIANGDAO_TOKEN || "").trim() || !String(QIANGDAO_REFRESH_TOKEN || "").trim()) {
    console.log("先填换号后的 QIANGDAO_TOKEN 和 QIANGDAO_REFRESH_TOKEN，再调用 startQiandaoTrades()");
    return;
  }
  const refreshed = await qiandaoRefresh();
  if (!refreshed) return qiandaoState();
  const state = qiandaoState();
  state.started_at = state.started_at || new Date().toISOString();
  state.stopped = null;
  const pending = QIANGDAO_SPUS.filter((spu) => !state.doneSpuIds.includes(String(spu.spu_id)));
  console.log(`待拉 ${pending.length} 个 SPU，每个只取前 ${pages} 页，间隔 ${QIANGDAO_INTERVAL_MS}ms 起`);
  for (let index = 0; index < pending.length; index += 1) {
    const spu = pending[index];
    for (let page = 0; page < pages; page += 1) {
      const offset = page * 20;
      let result;
      try {
        result = await qiandaoFetchPage(spu, offset);
      } catch (error) {
        state.stopped = { reason: "network", spu_id: spu.spu_id, message: String(error) };
        console.log("请求失败，已停。已有结果可 downloadQiandaoTrades()", error);
        return state;
      }
      if (result.status === 405 || qiandaoIsCaptcha(result.payload, result.status)) {
        state.stopped = {
          reason: result.status === 405 ? "waf" : "captcha",
          spu_id: spu.spu_id,
          status: result.status,
          payload: result.payload
        };
        console.log(result.status === 405
          ? "WAF 拒绝了。确认这段脚本是在微信 DevTools Console 里跑的。"
          : "遇到滑块 6700001，已停。人工验证后再次调用 startQiandaoTrades() 会从当前 SPU 继续。");
        return state;
      }
      const code = String(result.payload?.code ?? "");
      if (code && code !== "0") {
        state.stopped = { reason: "api", spu_id: spu.spu_id, payload: result.payload };
        console.log("接口返回非 0，已停，避免连续重试触发验证码。", result.payload);
        return state;
      }
      const rows = result.payload?.data?.items || [];
      for (const row of rows) {
        state.items.push({
          spu_id: String(spu.spu_id),
          category: spu.category,
          object_name: spu.object_name,
          variant_name: spu.variant_name || "",
          external_name: spu.external_name || "",
          buyerName: row.buyerName || "",
          tradingAmount: row.tradingAmount,
          isAcquisition: Boolean(row.isAcquisition),
          tradingTime: String(row.tradingTime || "")
        });
      }
      console.log(`${index + 1}/${pending.length} ${spu.object_name} ${spu.variant_name || ""} 第 ${page + 1} 页 ${rows.length} 条`);
      if (rows.length < 20) break;
      await qiandaoSleep(QIANGDAO_INTERVAL_MS + Math.floor(Math.random() * 5000));
    }
    state.doneSpuIds.push(String(spu.spu_id));
    if (index < pending.length - 1) {
      await qiandaoSleep(QIANGDAO_INTERVAL_MS + Math.floor(Math.random() * 5000));
    }
  }
  console.log(`拉完 ${state.items.length} 条。执行 downloadQiandaoTrades() 保存。`);
  return state;
}

function downloadQiandaoTrades() {
  qiandaoDownload();
}

console.log(`已载入 ${QIANGDAO_SPUS.length} 个 SPU。填好两个 token 后执行 startQiandaoTrades()。开跑前会先续期一次。默认每个 SPU 只拉 1 页，间隔 15 到 20 秒。`);
