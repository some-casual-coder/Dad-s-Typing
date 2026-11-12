// Non-working days for arrival dates. Kenya: Public Holidays Act dates, a
// Sunday holiday moves to Monday; Eid al-Fitr is gazetted each year, so the
// table holds expected dates. US: the major carrier holidays only.
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

// Anonymous Gregorian algorithm
export function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

const EID_AL_FITR: Record<number, string> = { 2026: "2026-03-20", 2027: "2027-03-10" };

function kenya(y: number): string[] {
  const fixed = [[1, 1], [5, 1], [6, 1], [10, 10], [10, 20], [12, 12], [12, 25], [12, 26]].map(([m, d]) => iso(y, m, d));
  const e = easter(y).getTime(), day = 86_400_000;
  const moving = [new Date(e - 2 * day), new Date(e + day)].map((d) => d.toISOString().slice(0, 10));
  const all = [...fixed, ...moving, ...(EID_AL_FITR[y] ? [EID_AL_FITR[y]] : [])];
  const out = new Set(all);
  for (const s of all) if (new Date(`${s}T00:00:00Z`).getUTCDay() === 0) {
    let n = new Date(`${s}T00:00:00Z`).getTime() + day;
    while (out.has(new Date(n).toISOString().slice(0, 10))) n += day;
    out.add(new Date(n).toISOString().slice(0, 10));
  }
  return [...out];
}

const nthWeekday = (y: number, m: number, weekday: number, n: number) => {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
};
const lastWeekday = (y: number, m: number, weekday: number) => {
  const last = new Date(Date.UTC(y, m, 0));
  return iso(y, m, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
};
// A Saturday holiday is observed Friday, a Sunday one Monday
const observed = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`), w = d.getUTCDay();
  return w === 6 ? new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10) : w === 0 ? new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10) : s;
};

function us(y: number): string[] {
  return [observed(iso(y, 1, 1)), lastWeekday(y, 5, 1), observed(iso(y, 7, 4)), nthWeekday(y, 9, 1, 1), nthWeekday(y, 11, 4, 4), observed(iso(y, 12, 25))];
}

const cache = new Map<string, Set<string>>();
export function isHoliday(dateIso: string, where: "ke" | "us"): boolean {
  const y = Number(dateIso.slice(0, 4));
  const k = `${where}:${y}`;
  if (!cache.has(k)) cache.set(k, new Set(where === "ke" ? kenya(y) : us(y)));
  return cache.get(k)!.has(dateIso);
}
