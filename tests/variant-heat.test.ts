import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVariantXianyuHeatLevel,
  VARIANT_XIANYU_HEAT_LEVELS
} from "../src/utils/variantHeat";

test("variant Xianyu heat accepts only the supported manual levels", () => {
  for (const level of VARIANT_XIANYU_HEAT_LEVELS) {
    assert.equal(parseVariantXianyuHeatLevel(level), level);
  }
  assert.equal(parseVariantXianyuHeatLevel(" HIGH "), "high");
  assert.equal(parseVariantXianyuHeatLevel("unknown"), null);
  assert.equal(parseVariantXianyuHeatLevel(undefined), null);
});
