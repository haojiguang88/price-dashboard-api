export const CSHRICH_ELECTRONICS_SOURCE_KEY = "cshrich_electronics";
export const CSHRICH_ELECTRONICS_SOURCE_NAME = "潮收汇电子产品报价";

export const CSHRICH_SEEDED_TOP_CATEGORIES = [
  { externalId: "1", externalName: "苹果", systemCategoryName: "苹果手机", tracked: false, skipReason: "已由苹果手机日更任务采集，不重复建品类" },
  { externalId: "5", externalName: "华为", systemCategoryName: "华为", tracked: true, skipReason: "" },
  { externalId: "8", externalName: "小米", systemCategoryName: "小米", tracked: true, skipReason: "" },
  { externalId: "18", externalName: "电脑", systemCategoryName: "电脑", tracked: true, skipReason: "" },
  { externalId: "38", externalName: "一加", systemCategoryName: "一加", tracked: true, skipReason: "" },
  { externalId: "42", externalName: "iQOO", systemCategoryName: "iQOO", tracked: true, skipReason: "" },
  { externalId: "48", externalName: "红米", systemCategoryName: "红米", tracked: true, skipReason: "" },
  { externalId: "77", externalName: "荣耀", systemCategoryName: "荣耀", tracked: true, skipReason: "" },
  { externalId: "85", externalName: "VIVO", systemCategoryName: "VIVO", tracked: true, skipReason: "" },
  { externalId: "90", externalName: "OPPO", systemCategoryName: "OPPO", tracked: true, skipReason: "" },
  { externalId: "94", externalName: "大疆", systemCategoryName: "大疆", tracked: true, skipReason: "" },
  { externalId: "181", externalName: "潮玩", systemCategoryName: "潮玩", tracked: true, skipReason: "" },
  { externalId: "236", externalName: "影石", systemCategoryName: "影石", tracked: true, skipReason: "" },
  { externalId: "239", externalName: "富士", systemCategoryName: "富士", tracked: true, skipReason: "" },
  { externalId: "317", externalName: "佳能", systemCategoryName: "佳能", tracked: true, skipReason: "" },
  { externalId: "366", externalName: "真我", systemCategoryName: "真我", tracked: true, skipReason: "" },
  { externalId: "387", externalName: "索尼", systemCategoryName: "索尼", tracked: true, skipReason: "" },
  { externalId: "932", externalName: "电脑硬件", systemCategoryName: "电脑硬件", tracked: true, skipReason: "" }
] as const;

export const ELECTRONICS_HIGH_UNIT_PRICE_CATEGORIES = new Set([
  "苹果手机",
  "游戏机",
  ...CSHRICH_SEEDED_TOP_CATEGORIES
    .filter((item) => item.tracked)
    .map((item) => item.systemCategoryName)
]);
