export type Settings = {
  facilityName: string;
  facilityAddress: string;
  facilityMapsUrl: string;
  gcashName: string;
  gcashNumber: string;
  gcashQrKey: string | null;
  bookingWindowDays: number;
  holdMinutes: number;
  warnMinutes: number;
  resubmitMinutes: number;
  cancelCutoffHours: number;
  slotMinutes: number;
  staffAlertEmails: string[];
  staffAlertSms: string[];
};

const DEFAULTS: Record<string, string> = {
  facility_name: 'Le Spinners Recreational Hub',
  facility_address: '',
  facility_maps_url: '',
  gcash_name: 'Le Spinners Recreational Hub',
  gcash_number: '',
  gcash_qr_key: '',
  booking_window_days: '14',
  hold_minutes: '10',
  warn_minutes: '2',
  resubmit_minutes: '10',
  cancel_cutoff_hours: '24',
  slot_minutes: '60',
  staff_alert_emails: '',
  staff_alert_sms: '',
};

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Settings change rarely; keep them for a few seconds per isolate to save a D1 round trip.
let cached: { at: number; value: Settings } | null = null;
const CACHE_MS = 10_000;

export function invalidateSettings(): void {
  cached = null;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await readSettings(db);
  cached = { at: Date.now(), value };
  return value;
}

async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map: Record<string, string> = { ...DEFAULTS };
  for (const row of results) map[row.key] = row.value;
  return {
    facilityName: map.facility_name ?? DEFAULTS.facility_name!,
    facilityAddress: map.facility_address ?? '',
    facilityMapsUrl: map.facility_maps_url ?? '',
    gcashName: map.gcash_name ?? '',
    gcashNumber: map.gcash_number ?? '',
    gcashQrKey: map.gcash_qr_key ? map.gcash_qr_key : null,
    bookingWindowDays: int(map.booking_window_days, 14, 1, 60),
    holdMinutes: int(map.hold_minutes, 10, 2, 60),
    warnMinutes: int(map.warn_minutes, 2, 1, 10),
    resubmitMinutes: int(map.resubmit_minutes, 10, 1, 60),
    cancelCutoffHours: int(map.cancel_cutoff_hours, 24, 0, 168),
    slotMinutes: int(map.slot_minutes, 60, 15, 240),
    staffAlertEmails: list(map.staff_alert_emails),
    staffAlertSms: list(map.staff_alert_sms),
  };
}

/** Settings the player app may see. */
export function publicSettings(s: Settings) {
  return {
    facilityName: s.facilityName,
    facilityAddress: s.facilityAddress,
    facilityMapsUrl: s.facilityMapsUrl,
    gcash: { name: s.gcashName, number: s.gcashNumber, hasQr: Boolean(s.gcashQrKey) },
    rules: {
      bookingWindowDays: s.bookingWindowDays,
      holdMinutes: s.holdMinutes,
      warnMinutes: s.warnMinutes,
      resubmitMinutes: s.resubmitMinutes,
      cancelCutoffHours: s.cancelCutoffHours,
      slotMinutes: s.slotMinutes,
      maxUploadMb: 10,
    },
  };
}
