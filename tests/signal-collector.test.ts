import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  parseXianbaokuPayload,
  resolveOriginSource
} from "../src/services/signal/adapters/xianbaokuAdapter";
import { parseXb86Detail, parseXb86List, resolveXb86Origin } from "../src/services/signal/adapters/xb86Adapter";
import { parseZuankebaDetail, parseZuankebaHomepage } from "../src/services/signal/adapters/zuankebaAdapter";
import {
  buildDedupeKeys,
  extractDealUrlFromHtml,
  normalizeUrl
} from "../src/services/signal/signalText";
import { extractSignalPrice } from "../src/services/signal/signalPrice";
import { parseLooseDateTime } from "../src/services/signal/signalTypes";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "signal", name), "utf8");

test("线报酷 JSON 解析：external_id、原始来源、绝对链接、精确时间、源站价格", () => {
  const signals = parseXianbaokuPayload(fixture("xianbaoku-push.json"), {
    collectedAt: "2026-10-07T19:00:00.000Z"
  });

  assert.ok(signals.length > 0, "应该解析出线报");
  for (const signal of signals) {
    assert.equal(signal.collectorSource, "xianbaoku");
    assert.ok(signal.externalId, "必须有 external_id");
    assert.ok(signal.title.length > 0);
    assert.ok(signal.url?.startsWith("https://new.ixbk.net/"), `详情链接要补成绝对地址：${signal.url}`);
    assert.match(String(signal.publishedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    assert.ok(signal.rawData.length > 0, "必须保留原始 JSON");
  }

  const origins = new Set(signals.map(signal => signal.originSource));
  assert.ok(origins.size >= 1);
  assert.ok(!origins.has("未知"), `catename 应该能解析出原始来源，实际：${[...origins].join(",")}`);
});

test("线报酷分类名映射到约定的 origin_source 词表", () => {
  assert.equal(resolveOriginSource("好单线报-日用-京东"), "好单");
  assert.equal(resolveOriginSource("微博-数码"), "微博");
  assert.equal(resolveOriginSource("赚客吧"), "赚客吧");
  assert.equal(resolveOriginSource("新赚吧"), "新赚吧");
  assert.equal(resolveOriginSource("小嘀咕"), "小嘀咕");
  assert.equal(resolveOriginSource("豆瓣线报"), "豆瓣");
  assert.equal(resolveOriginSource(""), "未知");
});

test("86 列表解析：置顶被标记、来源取图标 alt、时间补年份", () => {
  const items = parseXb86List(fixture("xb86-list.html"), new Date("2026-10-07T12:00:00+08:00"));

  assert.ok(items.length > 20, `列表应该有几十条，实际 ${items.length}`);
  assert.ok(items.some(item => item.pinned), "应该识别出置顶项");
  const normal = items.filter(item => !item.pinned);
  assert.ok(normal.every(item => /^\d+$/.test(item.externalId)));
  assert.ok(normal.every(item => item.url.includes(`/item/${item.externalId}.html`)));
  assert.ok(
    normal.some(item => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(item.publishedAt))),
    "列表时间要能补成完整时间戳"
  );
  assert.equal(resolveXb86Origin("好单线报"), "好单");
  assert.equal(resolveXb86Origin("微博线报"), "微博");
});

test("86 详情解析：结构化元数据给出正文与精确发布时间", () => {
  const detail = parseXb86Detail(fixture("xb86-detail.html"), new Date("2026-10-07T12:00:00+08:00"));

  assert.equal(detail.title, "丝塔芙大白罐保湿霜 55元");
  assert.match(String(detail.publishedAt), /^2026-10-07T19:13:51\+08:00$/);
  assert.ok(detail.content.includes("丝塔芙"), `正文应含商品名，实际：${detail.content}`);
  assert.equal(detail.originSource, "好单");
});

test("赚客吧首页 JSON-LD 解析：拿到今日线报清单", () => {
  const items = parseZuankebaHomepage(fixture("zuankeba-home.html"));

  assert.ok(items.length >= 10, `应该解析出今日线报，实际 ${items.length}`);
  assert.ok(items.every(item => /^[0-9a-f]+$/.test(item.externalId)));
  assert.ok(items.every(item => item.url.includes(`/d/${item.externalId}.html`)));
  assert.ok(items.every(item => item.title.length > 0));
  assert.equal(new Set(items.map(item => item.externalId)).size, items.length, "不能重复");
});

test("赚客吧详情解析：不要抓成站点标题", () => {
  const detail = parseZuankebaDetail(fixture("zuankeba-detail.html"), new Date("2026-10-07T12:00:00+08:00"));

  assert.equal(detail.title, "饿了么学生福利抢18-18无门槛券，京东特价9.9包邮");
  assert.notEqual(detail.title, "赚客吧");
  assert.match(String(detail.publishedAt), /^2026-10-07T18:38:35\+08:00$/);
  assert.ok(detail.content.length > 30, `正文不应为空，实际 ${detail.content.length}`);
});

test("外链抽取干净，可作为跨采集器合并键", () => {
  const payload = JSON.parse(fixture("xianbaoku-push.json")) as Array<{ content_html?: string }>;
  const withLink = payload.find(item => /href=/.test(String(item.content_html)));
  assert.ok(withLink, "fixture 里应该有带外链的线报");

  const dealUrl = extractDealUrlFromHtml(withLink!.content_html);
  assert.ok(dealUrl, "应该抽出外链");
  assert.ok(!dealUrl!.includes("\\"), `不能带 JSON 转义残留：${dealUrl}`);
  assert.ok(!/&amp;amp;/i.test(dealUrl!), `HTML 实体要解码：${dealUrl}`);
  assert.ok(/^https?:\/\//.test(dealUrl!));
});

test("同一个外链在三个采集器里得到同一个合并键", () => {
  const deal = "https://u.jd.com/F1QmxNQ";
  const base = { title: "某商品 99元", content: "某商品 99元" };
  const fromXianbaoku = buildDedupeKeys({ ...base, sourceKey: "xianbaoku", externalId: "1", url: "https://new.ixbk.net/haodan/1.html", dealUrl: deal });
  const fromXb86 = buildDedupeKeys({ ...base, sourceKey: "xb86", externalId: "2", url: "https://v.jiujiuxb.com/item/2.html", dealUrl: deal });
  const fromZuankeba = buildDedupeKeys({ ...base, sourceKey: "zuankeba", externalId: "abc", url: "https://www.zuankeba.cn/d/abc.html", dealUrl: deal });

  assert.equal(fromXianbaoku.crossSourceDedupeHash, fromXb86.crossSourceDedupeHash);
  assert.equal(fromXb86.crossSourceDedupeHash, fromZuankeba.crossSourceDedupeHash);
  // 源内仍然按各自 external_id 分开
  assert.notEqual(fromXianbaoku.sourceDedupeKey, fromXb86.sourceDedupeKey);
});

test("URL 归一化抹掉跟踪参数，让同一条详情页不重复", () => {
  assert.equal(normalizeUrl("https://www.zuankeba.cn/d/abc.html?utm_source=x"), "zuankeba.cn/d/abc.html");
  assert.equal(normalizeUrl("http://WWW.example.com/a/"), "example.com/a");
});

test("价格提取：只在有明确口径时给入手价", () => {
  const quantityCase = extractSignalPrice("某游戏机 XX版", "买2件凑单后每件2999元");
  assert.equal(quantityCase.quantity, 2);
  assert.equal(quantityCase.finalBuyPrice, 2999);
  assert.equal(quantityCase.priceStatus, "parsed");

  const single = extractSignalPrice("Apple Watch S11 1954元", "");
  assert.equal(single.finalBuyPrice, 1954);
  assert.equal(single.priceStatus, "parsed");

  const coupon = extractSignalPrice("某商品", "券后129元，原价299元");
  assert.equal(coupon.finalBuyPrice, 129);
  assert.equal(coupon.buyPrice, 299);

  const belowList = extractSignalPrice("虹桥别恋组合茶 19.9元", "京东此款目前活动售价59.9元");
  assert.equal(belowList.finalBuyPrice, 19.9);

  const ambiguous = extractSignalPrice("某商品 199元", "另一款 299元");
  assert.equal(ambiguous.priceStatus, "manual_review");
  assert.equal(ambiguous.finalBuyPrice, null, "口径不明时不能猜");
});

test("抽奖类线报的数字不算入手价", () => {
  const giveaway = extractSignalPrice("好想来碰一下支付抽10万份免单 最高免88元", "");
  assert.equal(giveaway.priceStatus, "manual_review");
  assert.equal(giveaway.finalBuyPrice, null);
  assert.equal(giveaway.detail.method, "promo_not_purchasable");

  const noPrice = extractSignalPrice("移动周三充值日抽8折话费券，邀请5人可直接领", "");
  assert.equal(noPrice.finalBuyPrice, null);
});

test("时间解析能吃下带 T 分隔符的 ISO 串", () => {
  assert.equal(parseLooseDateTime("2026-10-07T19:13:51+08:00"), "2026-10-07T19:13:51+08:00");
  assert.equal(parseLooseDateTime("10-07 19:13", new Date("2026-10-07T00:00:00+08:00")), "2026-10-07T19:13:00+08:00");
  assert.equal(parseLooseDateTime("2026-10-07 19:13"), "2026-10-07T19:13:00+08:00");
  assert.equal(parseLooseDateTime(""), null);
});
