const IST_OFFSET_MIN = 330;

/** Current time as "Friday, 2 October 2026, 2:35 pm IST" and ISO "2026-10-02T14:35:00+05:30". */
export function nowInIst(date = new Date()) {
  const text =
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date) + ' IST';

  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  const iso = ist.toISOString().replace(/\.\d{3}Z$/, '+05:30');
  return { text, iso };
}

export function istHour(date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(date),
  ) % 24;
}

/** Next moment inside [startHour, endHour) IST; returns the input if already inside. */
export function nextAllowedCallTime(date: Date, startHour: number, endHour: number): Date {
  const hour = istHour(date);
  if (hour >= startHour && hour < endHour) return date;
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  const target = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), startHour, 0, 0));
  if (hour >= endHour) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - IST_OFFSET_MIN * 60_000);
}
