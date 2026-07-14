export const VARIANT_XIANYU_HEAT_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "very_high"
] as const;

export type VariantXianyuHeatLevel = typeof VARIANT_XIANYU_HEAT_LEVELS[number];

export const parseVariantXianyuHeatLevel = (value: unknown): VariantXianyuHeatLevel | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VARIANT_XIANYU_HEAT_LEVELS.includes(normalized as VariantXianyuHeatLevel)
    ? normalized as VariantXianyuHeatLevel
    : null;
};
