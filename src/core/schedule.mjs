function parseDailyTime(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(String(value));
  if (!match) throw new Error(`自动同步时间格式无效：${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`自动同步时间无效：${value}`);
  return { value, minutes: hour * 60 + minute };
}

function localDateId(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function scheduledSlotId(now, dailyTimes) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("自动同步当前时间无效。");
  const schedule = [...new Set(dailyTimes)].map(parseDailyTime).sort((a, b) => a.minutes - b.minutes);
  if (!schedule.length) throw new Error("至少需要配置一个自动同步时间。");
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const current = [...schedule].reverse().find((item) => item.minutes <= currentMinutes);
  if (current) return `${localDateId(now)}@${current.value}`;
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  return `${localDateId(previous)}@${schedule.at(-1).value}`;
}

export function scheduledBudgetStatus(now, history, maximumPerDay, maximumPerMonth) {
  const currentDay = localDateId(now);
  const currentMonth = currentDay.slice(0, 7);
  const dates = history.map((value) => new Date(value)).filter((date) => Number.isFinite(date.getTime()));
  const dayCount = dates.filter((date) => localDateId(date) === currentDay).length;
  const monthCount = dates.filter((date) => localDateId(date).startsWith(currentMonth)).length;
  if (dayCount >= maximumPerDay) return { allowed: false, reason: "已达到今日自动部署上限" };
  if (monthCount >= maximumPerMonth) return { allowed: false, reason: "已达到本月自动部署上限" };
  return { allowed: true };
}
