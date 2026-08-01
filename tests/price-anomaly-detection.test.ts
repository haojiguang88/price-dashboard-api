import assert from "node:assert/strict";
import test from "node:test";
import { assessPriceMove } from "../src/services/priceAnomalyDetection";

test("isolated iPhone move of 540 yuan is review-worthy", () => {
  const assessment = assessPriceMove({
    categoryName: "苹果手机",
    changePercent: -6.14,
    changeAmount: -540
  });

  assert.equal(assessment.shouldAlert, true);
  assert.equal(assessment.profile, "high_unit_price");
});

test("ordinary ten-yuan iPhone move is not flagged", () => {
  const assessment = assessPriceMove({
    categoryName: "苹果手机",
    changePercent: -0.11,
    changeAmount: -10
  });

  assert.equal(assessment.shouldAlert, false);
});

test("general categories retain the existing thirty-percent threshold", () => {
  assert.equal(assessPriceMove({
    categoryName: "纪念币",
    changePercent: -6.14,
    changeAmount: -540
  }).shouldAlert, false);
  assert.equal(assessPriceMove({
    categoryName: "纪念币",
    changePercent: -35,
    changeAmount: -350
  }).shouldAlert, true);
});
