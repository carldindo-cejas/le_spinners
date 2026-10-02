import type { Context } from 'hono';

/** Bindings configured in wrangler.jsonc plus secrets. */
export type Bindings = {
  DB: D1Database;
  PROOFS: R2Bucket;
  ASSETS: Fetcher;
  TZ_OFFSET_MINUTES: string;
  APP_ORIGIN: string;
  FILE_SIGNING_SECRET: string;
  /** Key for HMAC-SHA256(PASSWORD_PEPPER, clientHash). A secret, never stored anywhere else. */
  PASSWORD_PEPPER: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

export type Role = 'player' | 'staff' | 'admin';
export type Membership = 'none' | 'pending' | 'member';
export type Activity = 'pickleball' | 'table_tennis';

export type BookingStatus =
  | 'TEMPORARY'
  | 'PAYMENT_SUBMITTED'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'COMPLETED';

/** Statuses that occupy a slot. REJECTED only while its resubmit window is open. */
export const ACTIVE_STATUSES: BookingStatus[] = ['TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'REJECTED'];

export type UserRow = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  password_hash: string; // HMAC-SHA256(PASSWORD_PEPPER, clientHash), base64url
  password_salt: string;
  password_iterations: number;
  password_scheme: string;
  role: Role;
  membership: Membership;
  member_code: string | null;
  member_until: string | null;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
};

export type SessionUser = Pick<UserRow, 'id' | 'email' | 'name' | 'phone' | 'role' | 'membership' | 'member_code' | 'member_until'> & {
  session_id: string;
};

export type ResourceRow = {
  id: string;
  activity: Activity;
  name: string;
  sort_order: number;
  status: 'active' | 'maintenance' | 'disabled';
  maintenance_note: string | null;
  maintenance_until: string | null;
  /** 1 = open play (free for all, not bookable). Only applies while status is 'active'. */
  open_play: number;
  price_member: number;
  price_non_member: number;
};

export type BookingRow = {
  id: string;
  ref: string;
  user_id: string;
  resource_id: string;
  date: string;
  start_min: number;
  end_min: number;
  status: BookingStatus;
  amount_due: number;
  rate: 'member' | 'non_member';
  hold_expires_at: number | null;
  warned_at: number | null;
  submitted_at: number | null;
  confirmed_at: number | null;
  confirmed_by: string | null;
  rejected_at: number | null;
  rejected_by: string | null;
  reject_reason: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  source: BookingSource;
  created_by: string | null;
  payment_method: PaymentMethod;
  /** Credit value used to pay for the booking; amount_due is the cash part. */
  credit_applied: number;
  /** Value already credited back for this booking (disruptions). */
  compensated_amount: number;
  /** The disruption that last changed this booking. */
  disruption_id: string | null;
  created_at: number;
  updated_at: number;
};

/** Where a booking was made: the player app, or a console (by staff or an admin). */
export type BookingSource = 'online' | 'staff' | 'admin';
export type PaymentMethod = 'gcash' | 'on_site' | 'none';

export type ProofRow = {
  id: string;
  booking_id: string;
  user_id: string;
  r2_key: string;
  content_type: string;
  size: number;
  original_name: string | null;
  gcash_ref: string | null;
  amount_claimed: number | null;
  status: 'submitted' | 'approved' | 'rejected';
  created_at: number;
};

export type Variables = {
  user: SessionUser | null;
  requestId: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type AppContext = Context<AppEnv>;
