import assert from "node:assert/strict";
import test from "node:test";
import { buildQualityAlertRecheckMetadata } from "../src/services/priceQualityAlertService";

test("plain quality alert recheck does not invent a correction record", () => {
  const metadata = buildQualityAlertRecheckMetadata({
    resolved: false,
    snapshotMessage: "价格变化异常",
    activeMessage: "当前疑点仍存在"
  });

  assert.equal(metadata.action, "recheck_unresolved");
  assert.equal(metadata.correctionRecordId, null);
  assert.match(metadata.note, /^重新检测后疑点仍存在/);
});

test("quality alert recheck links only an actual correction record", () => {
  const metadata = buildQualityAlertRecheckMetadata({
    resolved: true,
    correctionRecordId: 42,
    snapshotMessage: "价格变化异常"
  });

  assert.equal(metadata.action, "auto_fixed_after_correction");
  assert.equal(metadata.correctionRecordId, 42);
  assert.equal(metadata.note, "保存价格后自动巡检，原疑点已消失");
});

test("later manual rechecks preserve an existing correction relationship", () => {
  const metadata = buildQualityAlertRecheckMetadata({
    resolved: false,
    existingCorrectionRecordId: 42,
    snapshotMessage: "价格变化异常"
  });

  assert.equal(metadata.action, "recheck_unresolved");
  assert.equal(metadata.correctionRecordId, 42);
});
