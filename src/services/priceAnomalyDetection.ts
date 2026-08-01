const GENERAL_MOVE_PERCENT = 30;
const HIGH_UNIT_PRICE_MOVE_PERCENT = 3;
const HIGH_UNIT_PRICE_MOVE_AMOUNT = 300;

const HIGH_UNIT_PRICE_CATEGORIES = new Set(["苹果手机", "游戏机"]);

export interface PriceMoveAssessment {
  shouldAlert: boolean;
  profile: "general" | "high_unit_price";
  percentThreshold: number;
  amountThreshold: number | null;
}

export const assessPriceMove = ({
  categoryName,
  changePercent,
  changeAmount
}: {
  categoryName: string;
  changePercent: number;
  changeAmount: number;
}): PriceMoveAssessment => {
  const absolutePercent = Math.abs(changePercent);
  const absoluteAmount = Math.abs(changeAmount);

  if (HIGH_UNIT_PRICE_CATEGORIES.has(categoryName)) {
    return {
      shouldAlert: absolutePercent >= GENERAL_MOVE_PERCENT
        || (
          absolutePercent >= HIGH_UNIT_PRICE_MOVE_PERCENT
          && absoluteAmount >= HIGH_UNIT_PRICE_MOVE_AMOUNT
        ),
      profile: "high_unit_price",
      percentThreshold: HIGH_UNIT_PRICE_MOVE_PERCENT,
      amountThreshold: HIGH_UNIT_PRICE_MOVE_AMOUNT
    };
  }

  return {
    shouldAlert: absolutePercent >= GENERAL_MOVE_PERCENT,
    profile: "general",
    percentThreshold: GENERAL_MOVE_PERCENT,
    amountThreshold: null
  };
};
