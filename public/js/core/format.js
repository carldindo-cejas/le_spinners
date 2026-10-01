/** Display helpers. Facility time is Asia/Manila (UTC+8) wherever the player is. */

export const TZ = 'Asia/Manila';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** ₱500 · ₱1,250 · ₱500.50 (from centavos). `decimals` forces ₱500.00. */
export function peso(centavos, { decimals = false } = {}) {
  if (centavos == null || Number.isNaN(Number(centavos))) return '—';
  const value = Number(centavos) / 100;
  const whole = Number(centavos) % 100 === 0;
  return `₱${value.toLocaleString('en-PH', { minimumFractionDigits: decimals || !whole ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** 1080 → "6:00 PM" */
export function minutesLabel(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "6:00 – 7:00 PM" (same half of day) or "11:00 AM – 12:00 PM". */
export function rangeLabel(start, end) {
  const a = minutesLabel(start);
  const b = minutesLabel(end);
  if (a.slice(-2) === b.slice(-2)) return `${a.slice(0, -3)} – ${b}`;
  return `${a} – ${b}`;
}

/**
 * A booking's times: "6:00 – 7:00 PM", or with gaps "4:00 – 5:00 PM, 7:00 – 8:00 PM".
 * Uses `b.segments` (the API's booked times) and falls back to `b.start`–`b.end`.
 * `full` keeps AM/PM on both ends of each range.
 */
export function bookingTime(b, { full = false } = {}) {
  const segs = b.segments && b.segments.length ? b.segments : [{ start: b.start, end: b.end }];
  return segs.map((s) => (full ? rangeLabelFull(s.start, s.end) : rangeLabel(s.start, s.end))).join(', ');
}

/** Slot starts merged into continuous stretches: [960, 1020, 1140] with 60-minute slots → 4–6 PM and 7–8 PM. */
export function mergeStarts(starts, slotMinutes) {
  const out = [];
  for (const s of [...new Set(starts)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.end === s) last.end = s + slotMinutes;
    else out.push({ start: s, end: s + slotMinutes });
  }
  return out;
}

/** 60 → "1 hour", 120 → "2 hours", 90 → "90 min" */
export function durationLabel(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} min`;
}

/** "6:00 PM – 7:00 PM" */
export function rangeLabelFull(start, end) {
  return `${minutesLabel(start)} – ${minutesLabel(end)}`;
}

/** 1080 → "6 PM" */
export function hourLabel(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

function parts(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() };
}

/** "Fri, Oct 2" */
export function dateLabel(date) {
  const p = parts(date);
  return `${WEEKDAYS[p.w]}, ${MONTHS[p.m]} ${p.d}`;
}

/** "Friday, October 2, 2026" */
export function longDate(date) {
  const p = parts(date);
  return `${WEEKDAYS_LONG[p.w]}, ${MONTHS_LONG[p.m]} ${p.d}, ${p.y}`;
}

/** "Friday, October 2" */
export function dayMonth(date) {
  const p = parts(date);
  return `${WEEKDAYS_LONG[p.w]}, ${MONTHS_LONG[p.m]} ${p.d}`;
}

/** "October 2, 2026" */
export function monthDayYear(date) {
  const p = parts(date);
  return `${MONTHS_LONG[p.m]} ${p.d}, ${p.y}`;
}

/** "Oct 2" */
export function shortDate(date) {
  const p = parts(date);
  return `${MONTHS[p.m]} ${p.d}`;
}

export function weekdayShort(date) {
  return WEEKDAYS[parts(date).w];
}

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });

/** Epoch ms → "4:12 PM" facility time. */
export function clock(ms) {
  return ms ? clockFmt.format(new Date(ms)) : '';
}

/** Epoch ms → "Sep 29" */
export function dayOf(ms) {
  return dayFmt.format(new Date(ms));
}

/** Epoch ms → "Sep 29 · 4:07 PM" */
export function dayClock(ms) {
  return ms ? `${dayOf(ms)} · ${clock(ms)}` : '';
}

/** Epoch ms → facility date "2026-09-29" */
export function isoDate(ms) {
  return isoFmt.format(new Date(ms));
}

export function facilityHour(ms = Date.now()) {
  return Number(hourFmt.format(new Date(ms))) % 24;
}

export function greeting(ms = Date.now()) {
  const h = facilityHour(ms);
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "just now", "2 min ago", "3 hr ago", "Yesterday", "Sep 24" */
export function relTime(ms, now = Date.now()) {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (isoDate(ms) === isoDate(now)) return `${hr} hr ago`;
  if (isoDate(ms + 86_400_000) === isoDate(now)) return 'Yesterday';
  return dayOf(ms);
}

/** Whole minutes between two instants, at least 0. */
export function minutesBetween(a, b) {
  return Math.max(0, Math.floor((b - a) / 60_000));
}

/** 582000 → "09:42" */
export function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = words[0][0] || '';
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function activityLabel(activity) {
  return activity === 'table_tennis' ? 'Table Tennis' : 'Pickleball';
}

export function activityNoun(activity) {
  return activity === 'table_tennis' ? 'table' : 'court';
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
