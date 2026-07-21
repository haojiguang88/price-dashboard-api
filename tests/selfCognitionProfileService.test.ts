import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SELF_COGNITION_PROFILE,
  normalizeSelfCognitionProfileInput
} from "../src/services/selfCognitionProfileService";

test("self cognition profile keeps the recalibrated operating-stage structure", () => {
  const normalized = normalizeSelfCognitionProfileInput(DEFAULT_SELF_COGNITION_PROFILE);

  assert.equal(normalized.versionLabel, "2026 v2.2");
  assert.equal(normalized.phaseTitle, "运营验证阶段");
  assert.equal(normalized.content.currentRisks[0].title, "过度分析");
  assert.equal(normalized.content.currentRisks[0].rating, 3);
  assert.equal(normalized.content.currentRisks[1].title, "需要重视现金流");
  assert.equal(normalized.content.currentRisks[1].rating, 5);
  assert.equal(normalized.content.currentRisks[2].rating, 2);
  assert.equal(normalized.content.currentRisks[4].rating, 3);
  assert.equal(
    normalized.content.correctionFocus[1].title,
    "未经验证记录的观点统一放观察层"
  );
  assert.equal(
    normalized.content.correctionFocus.find(item => item.id === "accept-uncertainty")?.rating,
    3
  );
  assert.equal(normalized.content.controlledRisks[0].title, "容易开新坑");
  assert.match(normalized.content.controlledRisks[0].status, /已降级/);
});

test("self cognition profile rejects impossible dates", () => {
  assert.throws(
    () => normalizeSelfCognitionProfileInput({
      ...DEFAULT_SELF_COGNITION_PROFILE,
      profileDate: "2026-99-99"
    }),
    /不是有效日期/
  );
});

test("self cognition profile rejects ratings outside five stars", () => {
  assert.throws(
    () => normalizeSelfCognitionProfileInput({
      ...DEFAULT_SELF_COGNITION_PROFILE,
      content: {
        ...DEFAULT_SELF_COGNITION_PROFILE.content,
        currentRisks: [{ id: "risk", title: "风险", rating: 6, summary: "" }]
      }
    }),
    /0 到 5 颗星/
  );
});
