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
const QIANGDAO_SPUS = [{"spu_id": "1042229597409662992", "category": "宝可梦", "object_name": "30周年庆典统计", "variant_name": "30周年庆典统计", "external_name": "30thC 30周年庆典"}, {"spu_id": "851816824398995685", "category": "泡泡玛特", "object_name": "Labubu 前方高能系列", "variant_name": "整端", "external_name": "前方高能系列搪胶毛绒挂件"}, {"spu_id": "789523968431240995", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "万圣节", "external_name": "Magic of Pumpkin"}, {"spu_id": "704852597684613737", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "大春花", "external_name": "MOKOKO 春花"}, {"spu_id": "675597453717760702", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "大甜心", "external_name": "大甜心"}, {"spu_id": "1037744361988697639", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "寻找LABUBU系列", "external_name": "寻找LABUBU系列MOKOKO搪胶毛绒吊卡"}, {"spu_id": "672953785382971923", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "小甜心", "external_name": "小甜心"}, {"spu_id": "897177903526088129", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "晒晒", "external_name": "晒晒"}, {"spu_id": "915985249635145047", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "毛球", "external_name": "毛球"}, {"spu_id": "704906800172085180", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "白裙子", "external_name": "FALL INTO SPRING"}, {"spu_id": "970617028555622512", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "醒醒", "external_name": "醒醒"}, {"spu_id": "801090280999627960", "category": "泡泡玛特", "object_name": "MOKOKO系列", "variant_name": "闪闪", "external_name": "闪闪"}, {"spu_id": "929006833488630705", "category": "泡泡玛特", "object_name": "XG限定", "variant_name": "", "external_name": "XG限定"}, {"spu_id": "875239228831738922", "category": "泡泡玛特", "object_name": "Zsiga", "variant_name": "向往之处", "external_name": "向往之处"}, {"spu_id": "927988138113005044", "category": "泡泡玛特", "object_name": "Zsiga", "variant_name": "姜饼人", "external_name": "姜饼人1/8"}, {"spu_id": "1046003922327624571", "category": "泡泡玛特", "object_name": "Zsiga", "variant_name": "遇见的惊喜", "external_name": "遇见的惊喜1/8可动人偶"}, {"spu_id": "923539750290195305", "category": "泡泡玛特", "object_name": "哭娃", "variant_name": "咕噜咕噜", "external_name": "咕噜咕噜"}, {"spu_id": "791072292330313271", "category": "泡泡玛特", "object_name": "哭娃", "variant_name": "哭哭兔", "external_name": "哭哭兔"}, {"spu_id": "923539678349500863", "category": "泡泡玛特", "object_name": "哭娃", "variant_name": "恋夏一族", "external_name": "恋夏一族"}, {"spu_id": "713221358640770544", "category": "泡泡玛特", "object_name": "大娃", "variant_name": "mega400%梵高博物馆杏花", "external_name": "MEGA ROYAL MOLLY 400% 梵高博物馆·杏花"}, {"spu_id": "890886808303317137", "category": "泡泡玛特", "object_name": "大娃", "variant_name": "mega400%漫漫花落-绒", "external_name": "MEGA ROYAL MOLLY 400% 漫缦花落-绒"}, {"spu_id": "1046009656108966651", "category": "泡泡玛特", "object_name": "手办", "variant_name": "复古可口可乐火箭摆件", "external_name": "MEGA SPACE MOLLY 复古可口可乐 火箭摆件"}, {"spu_id": "954718264364114252", "category": "泡泡玛特", "object_name": "星星人礼盒", "variant_name": "", "external_name": "星星人礼盒"}, {"spu_id": "778075948925892646", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "大米兰", "external_name": "大米兰"}, {"spu_id": "681855448701274650", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "情人节", "external_name": "Catch Me If You Like Me"}, {"spu_id": "650794262396462371", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "拿铁", "external_name": "拿铁"}, {"spu_id": "802529831630726794", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "星夜许愿树毛绒公仔挂件", "external_name": "星夜许愿树毛绒公仔挂件"}, {"spu_id": "740254741795247881", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "蓝裙子", "external_name": "The Blue Diamond"}, {"spu_id": "593651152747287737", "category": "泡泡玛特", "object_name": "福袋专属", "variant_name": "飞行员", "external_name": "JUMP FOR JOY"}, {"spu_id": "839239297214219448", "category": "泡泡玛特", "object_name": "迪士尼联名", "variant_name": "唐老鸭的歌唱", "external_name": "唐老鸭的歌唱"}, {"spu_id": "839239377744850095", "category": "泡泡玛特", "object_name": "迪士尼联名", "variant_name": "奇奇和蒂蒂", "external_name": "奇奇和蒂蒂"}];

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
