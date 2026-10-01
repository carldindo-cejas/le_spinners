/**
 * Facility-local time helpers. The facility runs on one fixed UTC offset
 * (Asia/Manila, UTC+8, no daylight saving), so plain arithmetic is exact.
 */

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export type LocalNow = {
  /** epoch ms */
  ms: number;
  /** YYYY-MM-DD in facility time */
  date: string;
  /** minutes since local midnight */
  minutes: number;
  /** 0 = Sunday */
  weekday: number;
};

export function offsetMinutes(raw: string | undefined): number {
  const n = Number(raw ?? '480');
  return Number.isFinite(n) ? n : 480;
}

export function localNow(offsetMin: number, ms = Date.now()): LocalNow {
  const shifted = new Date(ms + offsetMin * MINUTE_MS);
  const date = shifted.toISOString().slice(0, 10);
  return {
    ms,
    date,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Epoch ms of a local date + minutes. */
export function localToMs(date: string, minutes: number, offsetMin: number): number {
  return Date.parse(`${date}T00:00:00Z`) + minutes * MINUTE_MS - offsetMin * MINUTE_MS;
}

export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri, Oct 2" */
export function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function peso(centavos: number): string {
  const whole = centavos % 100 === 0;
  const value = (centavos / 100).toLocaleString('en-PH', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `₱${value}`;
}

/** { weekday: 'Fri', month: 'Oct', day: 2 } */
export function dateParts(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()] ?? '', month: MONTHS[d.getUTCMonth()] ?? '', day: d.getUTCDate() };
}

/** "4:00 PM – 10:00 PM" */
export function hoursLabel(open: number, close: number): string {
  return `${minutesLabel(open)} – ${minutesLabel(close)}`;
}
