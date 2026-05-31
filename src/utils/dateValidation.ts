type RequiredDateValidation = { ok: true; value: string } | { ok: false; value: string; message: string };
type OptionalDateValidation = { ok: true; value: string | null } | { ok: false; value: string | null; message: string };

const normalizeDateInput = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

export const isValidDateOnly = (value: string) => {
  const normalized = normalizeDateInput(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;

  const [yearText, monthText, dayText] = normalized.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const isValidLocalDateTime = (value: string) => {
  const normalized = normalizeDateInput(value);
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;
  if (!isValidDateOnly(match[1])) return false;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);

  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    Number.isInteger(second) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
};

export const isValidDateOnlyOrLocalDateTime = (value: string) => (
  isValidDateOnly(value) || isValidLocalDateTime(value)
);

export const validateRequiredDateOnly = (value: unknown, label = '日期'): RequiredDateValidation => {
  const normalized = normalizeDateInput(value);
  if (!normalized) return { ok: false, value: normalized, message: `${label}不能为空` };
  if (!isValidDateOnly(normalized)) {
    return { ok: false, value: normalized, message: `${label}格式错误，请使用 YYYY-MM-DD` };
  }
  return { ok: true, value: normalized };
};

export const validateOptionalDateOnly = (value: unknown, label = '日期'): OptionalDateValidation => {
  const normalized = normalizeDateInput(value);
  if (!normalized) return { ok: true, value: null };
  if (!isValidDateOnly(normalized)) {
    return { ok: false, value: normalized, message: `${label}格式错误，请使用 YYYY-MM-DD` };
  }
  return { ok: true, value: normalized };
};

export const validateRequiredDateOnlyOrLocalDateTime = (value: unknown, label = '日期'): RequiredDateValidation => {
  const normalized = normalizeDateInput(value);
  if (!normalized) return { ok: false, value: normalized, message: `${label}不能为空` };
  if (!isValidDateOnlyOrLocalDateTime(normalized)) {
    return { ok: false, value: normalized, message: `${label}格式错误，请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm` };
  }
  return { ok: true, value: normalized };
};

export const validateOptionalDateOnlyOrLocalDateTime = (value: unknown, label = '日期'): OptionalDateValidation => {
  const normalized = normalizeDateInput(value);
  if (!normalized) return { ok: true, value: null };
  if (!isValidDateOnlyOrLocalDateTime(normalized)) {
    return { ok: false, value: normalized, message: `${label}格式错误，请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm` };
  }
  return { ok: true, value: normalized };
};
