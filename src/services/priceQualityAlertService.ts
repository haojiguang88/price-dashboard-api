interface QualityAlertRecheckMetadataInput {
  resolved: boolean;
  correctionRecordId?: number | null;
  existingCorrectionRecordId?: number | null;
  activeMessage?: string | null;
  snapshotMessage: string;
}

export interface QualityAlertRecheckMetadata {
  action: string;
  note: string;
  correctionRecordId: number | null;
}

const toPositiveRecordId = (value?: number | null) => (
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : null
);

export const buildQualityAlertRecheckMetadata = ({
  resolved,
  correctionRecordId,
  existingCorrectionRecordId,
  activeMessage,
  snapshotMessage
}: QualityAlertRecheckMetadataInput): QualityAlertRecheckMetadata => {
  const currentCorrectionRecordId = toPositiveRecordId(correctionRecordId);
  const linkedCorrectionRecordId = currentCorrectionRecordId
    ?? toPositiveRecordId(existingCorrectionRecordId);
  const afterCorrection = currentCorrectionRecordId !== null;

  if (resolved) {
    return {
      action: afterCorrection ? 'auto_fixed_after_correction' : 'recheck_resolved',
      note: afterCorrection ? '保存价格后自动巡检，原疑点已消失' : '重新检测，原疑点已消失',
      correctionRecordId: linkedCorrectionRecordId
    };
  }

  return {
    action: afterCorrection ? 'correction_recheck_unresolved' : 'recheck_unresolved',
    note: `${afterCorrection ? '保存价格后自动巡检，' : '重新检测后'}疑点仍存在：${activeMessage || snapshotMessage}`,
    correctionRecordId: linkedCorrectionRecordId
  };
};
