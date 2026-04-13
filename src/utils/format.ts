export function getYesterdayDateString(timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(new Date());
  const seg = todayStr.split('-');
  if (seg.length !== 3) return todayStr;
  const Y = Number.parseInt(seg[0]!, 10);
  const Mo = Number.parseInt(seg[1]!, 10);
  const D = Number.parseInt(seg[2]!, 10);
  const utcNoon = Date.UTC(Y, Mo - 1, D, 12, 0, 0);
  const yesterdayUtc = utcNoon - 86400000;
  return formatter.format(new Date(yesterdayUtc));
}

export function formatPercent(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function formatBytesMb(mb: number): string {
  return `${mb.toFixed(0)} MB`;
}
