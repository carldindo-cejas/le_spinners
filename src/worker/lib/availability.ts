import type { Activity, Bindings, BookingStatus, Membership, ResourceRow } from '../types';
import { OCCUPYING, closureCovers, isOpenPlay, underMaintenance, type ClosureRow, type HoursRow } from './bookings';
import type { Settings } from './settings';
import { addDays, dateLabel, dateParts, daysBetween, hoursLabel, localNow, minutesLabel, offsetMinutes, peso, weekdayOf, type LocalNow } from './time';

/**
 * Slot states. Players only ever learn *that* a slot is taken, never by whom:
 *   held        → someone's unpaid hold (may reopen)
 *   unavailable → payment proof is being verified
 *   booked      → confirmed
 *   mine        → the signed-in player's own booking
 *   open_play   → the court or table is free for all: shown, never bookable
 */
export type SlotState = 'available' | 'held' | 'unavailable' | 'booked' | 'maintenance' | 'open_play' | 'closed' | 'past' | 'mine';

type OccupyingRow = {
  id: string;
  ref: string;
  user_id: string;
  resource_id: string;
  date: string;
  start_min: number;
  end_min: number;
  status: BookingStatus;
  hold_expires_at: number | null;
  user_name: string;
  user_membership: Membership;
};

type Ctx = {
  resources: ResourceRow[];
  hours: Map<number, HoursRow>;
  closures: ClosureRow[];
  bookings: OccupyingRow[];
};

type Viewer =
  | { staff: false; userId: string; membership: Membership }
  | { staff: true };

type PlayerSlot = { start: number; end: number; label: string; state: SlotState; booking?: { id: string; status: BookingStatus } };
type StaffSlot = {
  start: number;
  end: number;
  label: string;
  state: SlotState;
  booking?: { id: string; ref: string; status: BookingStatus; userName: string; membership: Membership; holdExpiresAt: number | null };
};

async function loadCtx(db: D1Database, activity: Activity | null, from: string, to: string, now: number): Promise<Ctx> {
  const resourceStmt = activity
    ? db.prepare(`SELECT * FROM resources WHERE status != 'disabled' AND activity = ? ORDER BY sort_order, name`).bind(activity)
    : db.prepare(`SELECT * FROM resources WHERE status != 'disabled' ORDER BY activity, sort_order, name`);
  const [resources, hours, closures, bookings] = await db.batch([
    resourceStmt,
    db.prepare('SELECT * FROM opening_hours'),
    db.prepare('SELECT * FROM closures WHERE date BETWEEN ? AND ?').bind(from, to),
    // One row per booked stretch of time: a booking with gaps occupies only its own slots.
    db
      .prepare(
        `SELECT b.id, b.ref, b.user_id, t.resource_id, t.date, t.start_min, t.end_min, b.status, b.hold_expires_at,
                u.name AS user_name, u.membership AS user_membership
           FROM booking_times t JOIN bookings b ON b.id = t.booking_id JOIN users u ON u.id = b.user_id
          WHERE t.date BETWEEN ?1 AND ?2 AND ${OCCUPYING('b', '?3')}`,
      )
      .bind(from, to, now),
  ]);
  return {
    resources: (resources?.results ?? []) as ResourceRow[],
    hours: new Map(((hours?.results ?? []) as HoursRow[]).map((h) => [h.weekday, h])),
    closures: (closures?.results ?? []) as ClosureRow[],
    bookings: (bookings?.results ?? []) as OccupyingRow[],
  };
}

export function slotStarts(h: HoursRow | undefined, slotMinutes: number): number[] {
  if (!h || !h.is_open) return [];
  const out: number[] = [];
  for (let s = h.open_min; s + slotMinutes <= h.close_min; s += slotMinutes) out.push(s);
  return out;
}

function occupiedState(status: BookingStatus): SlotState {
  if (status === 'CONFIRMED') return 'booked';
  if (status === 'PAYMENT_SUBMITTED') return 'unavailable';
  return 'held';
}

function buildDay(ctx: Ctx, date: string, local: LocalNow, settings: Settings, viewer: Viewer) {
  const hours = ctx.hours.get(weekdayOf(date));
  const starts = slotStarts(hours, settings.slotMinutes);
  const ahead = daysBetween(local.date, date);
  const dayClosures = ctx.closures.filter((c) => c.date === date);
  const facilityClosure = dayClosures.find((c) => !c.resource_id && (c.start_min == null || c.end_min == null)) ?? null;
  const dayBookings = ctx.bookings.filter((b) => b.date === date);
  const inWindow = ahead >= 0 && ahead <= settings.bookingWindowDays;

  const resources = ctx.resources.map((r) => {
    const maintenance = underMaintenance(r, date);
    const openPlay = isOpenPlay(r);
    const slots = starts.map((start) => {
      const end = start + settings.slotMinutes;
      const booking = dayBookings.find((b) => b.resource_id === r.id && b.start_min < end && b.end_min > start);
      const past = ahead < 0 || (ahead === 0 && start <= local.minutes);
      let state: SlotState;
      if (viewer.staff && booking) state = occupiedState(booking.status);
      else if (past) state = 'past';
      else if (dayClosures.some((c) => closureCovers(c, r.id, start, end))) state = 'closed';
      else if (maintenance) state = 'maintenance';
      else if (openPlay) state = 'open_play';
      else if (booking) state = booking.user_id === (viewer.staff ? null : viewer.userId) ? 'mine' : occupiedState(booking.status);
      else state = inWindow ? 'available' : 'closed';

      if (viewer.staff) {
        const slot: StaffSlot = { start, end, label: minutesLabel(start), state };
        if (booking) {
          slot.booking = {
            id: booking.id,
            ref: booking.ref,
            status: booking.status,
            userName: booking.user_name,
            membership: booking.user_membership,
            holdExpiresAt: booking.status === 'TEMPORARY' || booking.status === 'REJECTED' ? booking.hold_expires_at : null,
          };
        }
        return slot;
      }
      const slot: PlayerSlot = { start, end, label: minutesLabel(start), state };
      if (booking && state === 'mine') slot.booking = { id: booking.id, status: booking.status };
      return slot;
    });

    const memberRate = !viewer.staff && viewer.membership === 'member';
    return {
      id: r.id,
      name: r.name,
      activity: r.activity,
      status: maintenance ? ('maintenance' as const) : openPlay ? ('open_play' as const) : ('active' as const),
      maintenance: maintenance
        ? { note: r.maintenance_note, until: r.maintenance_until, untilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null }
        : null,
      price: memberRate ? r.price_member : r.price_non_member,
      priceLabel: peso(memberRate ? r.price_member : r.price_non_member),
      priceMember: r.price_member,
      priceNonMember: r.price_non_member,
      slots,
    };
  });

  return {
    date,
    dateLabel: dateLabel(date),
    ...dateParts(date),
    isToday: ahead === 0,
    open: starts.length > 0 && !facilityClosure,
    hours: hours && hours.is_open ? { open: hours.open_min, close: hours.close_min, label: hoursLabel(hours.open_min, hours.close_min) } : null,
    closedReason: facilityClosure ? facilityClosure.reason ?? 'Closed' : null,
    slotMinutes: settings.slotMinutes,
    resources,
  };
}

/** One day's grid for a player (or staff with names when `viewer.staff`). */
export async function dayAvailability(
  env: Bindings,
  settings: Settings,
  input: { activity: Activity | null; date: string },
  viewer: Viewer,
  now = Date.now(),
) {
  const local = localNow(offsetMinutes(env.TZ_OFFSET_MINUTES), now);
  const ctx = await loadCtx(env.DB, input.activity, input.date, input.date, now);
  return { now, today: local.date, ...buildDay(ctx, input.date, local, settings, viewer) };
}

export type DayLoad = 'open' | 'few' | 'full' | 'closed';

/** The date strip: how busy each bookable day is for one activity. */
export async function daysSummary(
  env: Bindings,
  settings: Settings,
  activity: Activity,
  viewer: { userId: string; membership: Membership },
  now = Date.now(),
) {
  const local = localNow(offsetMinutes(env.TZ_OFFSET_MINUTES), now);
  const to = addDays(local.date, settings.bookingWindowDays);
  const ctx = await loadCtx(env.DB, activity, local.date, to, now);
  const days = [];
  for (let i = 0; i <= settings.bookingWindowDays; i++) {
    const date = addDays(local.date, i);
    const day = buildDay(ctx, date, local, settings, { staff: false, ...viewer });
    let available = 0;
    let bookable = 0;
    for (const r of day.resources) {
      for (const s of r.slots) {
        if (s.state === 'available') available++;
        if (s.state === 'available' || s.state === 'held' || s.state === 'unavailable' || s.state === 'booked' || s.state === 'mine') bookable++;
      }
    }
    let load: DayLoad;
    if (!day.open || bookable === 0) load = 'closed';
    else if (available === 0) load = 'full';
    else if (available <= Math.max(2, Math.floor(bookable * 0.2))) load = 'few';
    else load = 'open';
    days.push({
      date,
      dateLabel: day.dateLabel,
      weekday: day.weekday,
      month: day.month,
      day: day.day,
      isToday: i === 0,
      load,
      available,
      // Courts or tables in open play that day: nothing to book, but players can still look.
      openPlay: day.open ? day.resources.filter((r) => r.status === 'open_play').length : 0,
      closedReason: day.closedReason,
    });
  }
  return { now, today: local.date, activity, days };
}

/**
 * Open times to offer when the chosen ones were just taken.
 *   one slot      → nearby free slots: the same time elsewhere first, then the closest times
 *   several slots → the same times on another court or table where all are free, then the
 *                   ones still free on the chosen court
 * Each option is a full pick: `starts` (and `start`, the first of them).
 */
export async function alternativesFor(
  env: Bindings,
  settings: Settings,
  viewer: { userId: string; membership: Membership },
  input: { resourceId: string; date: string; starts: number[] },
  now = Date.now(),
) {
  const wanted = [...new Set(input.starts)].sort((a, b) => a - b);
  if (!wanted.length) return [];
  const resource = await env.DB.prepare('SELECT activity FROM resources WHERE id = ?').bind(input.resourceId).first<{ activity: Activity }>();
  if (!resource) return [];
  const day = await dayAvailability(env, settings, { activity: resource.activity, date: input.date }, { staff: false, ...viewer }, now);
  type Option = { resourceId: string; resourceName: string; date: string; start: number; starts: number[]; label: string; score: number };
  const options: Option[] = [];
  const option = (r: { id: string; name: string }, starts: number[], label: string, score: number): Option =>
    ({ resourceId: r.id, resourceName: r.name, date: input.date, start: starts[0]!, starts, label, score });

  if (wanted.length === 1) {
    const want = wanted[0]!;
    for (const r of day.resources) {
      for (const s of r.slots) {
        if (s.state !== 'available') continue;
        options.push(option(r, [s.start], `${r.name} · ${minutesLabel(s.start)}`, Math.abs(s.start - want) * 2 + (r.id === input.resourceId ? 0 : 1)));
      }
    }
  } else {
    for (const r of day.resources) {
      const open = new Set(r.slots.filter((s) => s.state === 'available').map((s) => s.start));
      if (r.id !== input.resourceId) {
        if (wanted.every((s) => open.has(s))) options.push(option(r, wanted, `${r.name} · same times`, 0));
      } else {
        const still = wanted.filter((s) => open.has(s));
        if (still.length) options.push(option(r, still, `${r.name} · the ${still.length} times still open`, 1));
      }
    }
  }
  options.sort((a, b) => a.score - b.score || a.start - b.start);
  return options.slice(0, 4).map(({ score: _score, ...o }) => o);
}
