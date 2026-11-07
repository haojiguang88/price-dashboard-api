const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_BACKFILL_DAYS = 7;

export function shiftDateKey(dateKey: string, days: number): string {
  const match = DATE_KEY.exec(dateKey);
  if (!match) {
    throw new Error(`日期格式应为 YYYY-MM-DD：${dateKey}`);
  }
  const shifted = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days
  ));
  return shifted.toISOString().slice(0, 10);
}

export function resolveXiaogeBackfillDates(
  config: { backfill?: unknown; backfill_days?: unknown },
  todayKey: string
): string[] {
  const daysRaw = config.backfill_days;
  if (daysRaw !== undefined && daysRaw !== null && String(daysRaw).trim() !== '') {
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) {
      throw new Error(`小鸽 backfill_days 需要是 1 到 ${MAX_BACKFILL_DAYS} 的整数，当前是 ${daysRaw}`);
    }
    const dates: string[] = [];
    for (let offset = days; offset >= 1; offset -= 1) {
      dates.push(shiftDateKey(todayKey, -offset));
    }
    return dates;
  }

  const raw = String(config.backfill ?? '').trim();
  if (!raw) return [];
  if (raw === 'yesterday') return [shiftDateKey(todayKey, -1)];
  if (DATE_KEY.test(raw)) return [raw];
  throw new Error(`小鸽回填日期无法识别：${raw}`);
}
