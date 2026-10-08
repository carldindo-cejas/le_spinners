/** Server time drives grouping. endsAt is authoritative; older cached DTOs use their end/segments. */
export function bookingEndsAt(booking) {
  if (Number.isFinite(booking.endsAt)) return booking.endsAt;
  const ends = (booking.segments || []).filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).map(s => s.end);
  const end = ends.length ? Math.max(...ends) : booking.end;
  return Number.isFinite(booking.startsAt) && Number.isFinite(end) && Number.isFinite(booking.start)
    ? booking.startsAt + (end - booking.start) * 60_000 : NaN;
}

export function bookingGroup(booking, now) {
  if (booking.status === 'CANCELLED') return 'cancelled';
  // Verification and a still-open proof window remain actionable after scheduled play ends.
  if (booking.status === 'PAYMENT_SUBMITTED' || (['TEMPORARY', 'REJECTED'].includes(booking.status) && booking.canSubmitProof)) return 'upcoming';
  return booking.status === 'CONFIRMED' && bookingEndsAt(booking) > now ? 'upcoming' : 'past';
}

export function splitBookings(bookings, now) {
  const groups = { upcoming:[], past:[], cancelled:[] };
  for (const booking of bookings) groups[bookingGroup(booking, now)].push(booking);
  groups.upcoming.sort((a,b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  return groups;
}
