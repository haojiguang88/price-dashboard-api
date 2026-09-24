const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export const weekdayInChina = (now = new Date()) => {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short"
  }).format(now);
  return WEEKDAY_MAP[weekday] ?? now.getDay();
};

export const isRunnableToday = (scheduleDays: string, now = new Date()) => {
  const day = weekdayInChina(now);
  if (scheduleDays === "every_day") return true;
  if (scheduleDays === "work_days") return day >= 1 && day <= 5;
  if (scheduleDays === "weekly_sunday") return day === 0;
  return true;
};

export const getFreshnessThresholdHours = (scheduleDays: string) => {
  if (scheduleDays === "work_days") return 84;
  if (scheduleDays === "weekly_sunday") return 192;
  return 36;
};
