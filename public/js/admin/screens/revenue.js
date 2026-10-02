import { api } from '../../core/api.js';
import { $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { addDays, bookingTime, clock, dateLabel, dayClock, isoDate, longDate, peso, shortDate } from '../../core/format.js';
import { errorState, poll, skeletonRows, toast } from '../../core/ui.js';
import { bell, frame, showSessionExpired } from '../shell.js';
import { API, BASE, REVENUE } from '../console.js';

/**
 * Revenue (admin only, /revenue/). Read-only reporting over verified payments.
 * The server owns every figure and every accounting rule (src/worker/routes/revenue.ts);
 * this screen only formats them. The date period (quick chips or From–To) sits inside
 * the Booking Ledger and only filters the ledger; the summary cards are fixed periods.
 */

const QUICK = [
  { key: '7d', label: '7D', title: 'Last 7 days' },
  { key: '30d', label: '30D', title: 'Last 30 days' },
  { key: '3m', label: '3M', title: 'Last 3 months' },
  { key: '1y', label: '1Y', title: 'Last 12 months' },
];
const RANGES = [...QUICK.map((r) => r.key), 'custom'];
const PAY_STATUS = [
  { key: 'paid', label: 'Paid · verified' },
  { key: 'pending', label: 'Pending verification' },
  { key: 'rejected', label: 'Proof rejected' },
  { key: 'cancelled_credited', label: 'Cancelled · credited' },
  { key: 'cancelled_paid', label: 'Cancelled after payment' },
  { key: 'cancelled_unverified', label: 'Cancelled · not verified' },
];
// Table badges are short; the line under each says the rest (phones show the full label).
const STATUS_PILL = {
  paid: { cls: 'green', icon: 'check-circle', short: 'Paid' },
  pending: { cls: 'violet', icon: 'shield-clock', short: 'Pending' },
  rejected: { cls: 'red', icon: 'x-circle', short: 'Rejected' },
  cancelled_credited: { cls: 'blue', icon: 'gift', short: 'Credited' },
  cancelled_paid: { cls: 'amber', icon: 'alert', short: 'Cancelled' },
  cancelled_unverified: { cls: 'neutral', icon: 'circle-slash', short: 'Cancelled' },
};
const statusSub = (r) => ({
  paid: r.verifiedBy ? `Verified by ${r.verifiedBy}` : 'Verified',
  pending: '',
  rejected: 'Proof rejected · not collected',
  cancelled_credited: 'Cancelled by Le Spinners · value kept as booking credit',
  cancelled_paid: 'After payment · refund not recorded',
  cancelled_unverified: 'Before verification',
})[r.payStatus] || '';
const COLUMNS = [
  { key: 'date', label: 'Date & time' },
  { key: 'ref', label: 'Booking ID' },
  { key: 'user', label: 'User' },
  { key: 'facility', label: 'Facility' },
  { key: 'type', label: 'Type' },
  { key: 'duration', label: 'Duration' },
  { key: 'amount', label: 'Amount', right: true },
  { key: 'method', label: 'Payment method' },
  { key: 'status', label: 'Payment status' },
];
// Phones get one sort menu instead of column headers.
const MOBILE_SORTS = [
  { key: 'date:desc', label: 'Newest first' },
  { key: 'date:asc', label: 'Oldest first' },
  { key: 'amount:desc', label: 'Highest amount' },
  { key: 'amount:asc', label: 'Lowest amount' },
  { key: 'user:asc', label: 'Customer A–Z' },
  { key: 'status:asc', label: 'By status' },
];
// Each card compares with the previous period up to the same point (e.g. Mon–Thu vs Mon–Thu).
const CARD = {
  day: { tone: 'green', icon: 'calendar', cmp: 'yesterday by this time' },
  week: { tone: 'blue', icon: 'calendar-clock', cmp: 'by this point last week' },
  month: { tone: 'violet', icon: 'calendar-grid', cmp: 'by this point last month' },
  year: { tone: 'amber', icon: 'calendar-plus', cmp: 'by this point last year' },
};
const SIZES = [10, 25, 50];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const money = (centavos) => peso(centavos, { decimals: true });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** [from, to] (inclusive facility dates) for a preset, relative to the facility's today. */
function presetRange(key, today) {
  switch (key) {
    case '30d': return [addDays(today, -29), today];
    case '3m': return [addDays(addMonths(today, -3), 1), today];
    case '1y': return [addDays(addMonths(today, -12), 1), today];
    default: return [addDays(today, -6), today];
  }
}

/** Replaces the text after the spinner in a busy button. */
function busyText(btn, text) {
  const node = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text;
}

function durationLabel(min) {
  if (min % 60 === 0) return min === 60 ? '1 hr' : `${min / 60} hrs`;
  return min > 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function readState(query, today) {
  const range = pick(query.get('range'), RANGES, '7d');
  let [from, to] = presetRange(range, today);
  if (range === 'custom') {
    const qf = query.get('from');
    const qt = query.get('to');
    if (DATE_RE.test(qf || '') && DATE_RE.test(qt || '') && qf <= qt) [from, to] = [qf, qt];
  }
  const size = Number(query.get('size'));
  const page = Number(query.get('page'));
  return {
    range,
    from,
    to,
    q: (query.get('q') || '').slice(0, 80),
    resource: /^[A-Za-z0-9_-]{1,64}$/.test(query.get('resource') || '') ? query.get('resource') : '',
    type: pick(query.get('type'), ['pickleball', 'table_tennis'], ''),
    method: pick(query.get('method'), ['gcash', 'on_site'], ''),
    status: pick(query.get('status'), PAY_STATUS.map((s) => s.key), ''),
    sort: pick(query.get('sort'), COLUMNS.map((c) => c.key), 'date'),
    dir: pick(query.get('dir'), ['asc', 'desc'], 'desc'),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: SIZES.includes(size) ? size : 10,
  };
}

/** Query string for the API (and the page URL, which also keeps the preset name). */
function toQuery(f, { forUrl = false, paged = true } = {}) {
  const p = new URLSearchParams();
  if (forUrl) {
    if (f.range !== '7d') p.set('range', f.range);
    if (f.range === 'custom') {
      p.set('from', f.from);
      p.set('to', f.to);
    }
  } else {
    p.set('from', f.from);
    p.set('to', f.to);
  }
  for (const k of ['q', 'resource', 'type', 'method', 'status']) if (f[k]) p.set(k, f[k]);
  if (!forUrl || f.sort !== 'date') p.set('sort', f.sort);
  if (!forUrl || f.dir !== 'desc') p.set('dir', f.dir);
  if (paged) {
    if (!forUrl || f.page !== 1) p.set('page', String(f.page));
    if (!forUrl || f.size !== 10) p.set('size', String(f.size));
  }
  return p.toString();
}

function rangeText(from, to) {
  const md = (d) => dateLabel(d).split(', ')[1];
  if (from === to) return `${md(to)}, ${to.slice(0, 4)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${md(from)} – ${md(to)}, ${to.slice(0, 4)}`;
  return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`;
}

// ── Pieces ────────────────────────────────────────────────────────────────

function changeChip(p) {
  const c = p.change;
  if (c.direction === 'flat') return html`<span class="rev-change flat">${icon('minus-circle', 14, 2.4)}No change</span>`;
  const up = c.direction === 'up';
  const sign = up ? '+' : '−';
  const words = c.pct == null ? `${sign}${money(Math.abs(c.amount))}` : `${sign}${Math.abs(c.pct)}%`;
  return html`<span class="rev-change ${up ? 'up' : 'down'}"><span class="sr-only">${up ? 'Up' : 'Down'} </span>${icon(up ? 'trending-up' : 'trending-down', 15, 2.4)}${words}</span>`;
}

function summaryCard(p) {
  const a = CARD[p.key];
  const cxl = p.cancelledAfterPayment;
  return html`<article class="rev-card ${a.tone}" aria-labelledby="rev-${p.key}">
    <div class="rev-card-head"><span class="tile sm ${a.tone}">${icon(a.icon, 20)}</span><h3 class="eyebrow" id="rev-${p.key}">${p.label}</h3></div>
    <p class="rev-amt">${money(p.collected)}</p>
    <p class="rev-cmp">${changeChip(p)}<span class="meta">vs ${money(p.previous.toDate)} ${a.cmp}</span></p>
    <p class="meta">${plural(p.payments, 'payment')} · ${p.rangeLabel}</p>
    ${cxl.count ? html`<p class="meta amber-text rev-foot">${icon('alert', 14, 2.2)}<span>${money(cxl.amount)} cancelled after payment · not included</span></p>` : ''}
  </article>`;
}

function statusPill(r, { short = false } = {}) {
  const s = STATUS_PILL[r.payStatus] || STATUS_PILL.cancelled_unverified;
  return html`<span class="pill sm ${s.cls}" title="${r.payStatusLabel}">${icon(s.icon, 12, 2.4)}${short ? s.short : r.payStatusLabel}</span>`;
}

/** "name@" + "example.com": long emails break after the @, not mid-word. */
function emailCell(email) {
  const at = email.lastIndexOf('@');
  return at > 0 ? html`${email.slice(0, at + 1)}<wbr>${email.slice(at + 1)}` : email;
}

function whenCell(r, thisYear) {
  const year = isoDate(r.at).slice(0, 4);
  return html`${dayClock(r.at)}<span class="sub">${r.atKind}${year !== thisYear ? ` · ${year}` : ''}</span>`;
}

function tableRow(r, thisYear) {
  return html`<tr>
    <td class="nowrap">${whenCell(r, thisYear)}</td>
    <td class="nowrap"><a class="ref" href="${BASE}/bookings/${r.id}">${r.ref}</a></td>
    <td class="cell-user"><span class="strong">${r.bookerName || r.user.name}</span><span class="sub">${r.bookerName ? `On site · ${r.user.name}` : emailCell(r.user.email)}</span></td>
    <td>${r.resource.name}<span class="sub">${shortDate(r.date)} · ${bookingTime(r)}</span></td>
    <td>${r.activityLabel}</td>
    <td class="nowrap">${durationLabel(r.durationMin)}</td>
    <td class="r mono nowrap${r.countsAsRevenue ? '' : ' amt-muted'}">${money(r.amount)}</td>
    <td class="cell-method">${r.methodLabel}${r.gcashRef ? html`<span class="sub">Ref ${r.gcashRef}</span>` : ''}</td>
    <td class="cell-status">${statusPill(r, { short: true })}${statusSub(r) ? html`<span class="sub">${statusSub(r)}</span>` : ''}</td>
    <td><div class="row-actions">${r.payStatus === 'pending'
      ? html`<a class="btn btn-violet btn-xs" href="${BASE}/verify/${r.id}" aria-label="Review payment for ${r.ref}">Review</a>`
      : html`<a class="icon-btn" href="${BASE}/bookings/${r.id}" aria-label="View booking ${r.ref}">${icon('chevron-right', 18, 2.2)}</a>`}</div></td>
  </tr>`;
}

function mobileCard(r, thisYear) {
  return html`<a class="m-card ledger-card" href="${r.payStatus === 'pending' ? `${BASE}/verify/${r.id}` : `${BASE}/bookings/${r.id}`}">
    <div class="row row-between" data-gap="8"><span class="mono meta nowrap">${r.ref}</span>${statusPill(r, { short: true })}</div>
    <div class="row row-between row-top" data-gap="12">
      <span class="grow"><span class="strong">${r.bookerName || r.user.name}</span><br><span class="small">${r.resource.name} · ${r.activityLabel} · ${durationLabel(r.durationMin)}</span></span>
      <span class="mono strong nowrap${r.countsAsRevenue ? '' : ' amt-muted'}">${money(r.amount)}</span>
    </div>
    <span class="meta">${r.atKind} · ${dayClock(r.at)}${isoDate(r.at).slice(0, 4) !== thisYear ? `, ${isoDate(r.at).slice(0, 4)}` : ''} · ${r.methodLabel}${r.gcashRef ? ` · Ref ${r.gcashRef}` : ''}</span>
    ${statusSub(r) ? html`<span class="meta">${statusSub(r)}</span>` : ''}
  </a>`;
}

/** 1 … 4 5 6 … 12 */
function pageList(page, pages) {
  const want = new Set([1, pages, page - 1, page, page + 1]);
  const out = [];
  let last = 0;
  for (let p = 1; p <= pages; p++) {
    if (!want.has(p)) continue;
    if (p - last > 1) out.push(null);
    out.push(p);
    last = p;
  }
  return out;
}

function pager(d) {
  const start = d.total ? (d.page - 1) * d.size + 1 : 0;
  const end = Math.min(d.total, d.page * d.size);
  return html`<p class="small" aria-live="polite">Showing ${start}–${end} of ${plural(d.total, 'record')}</p>
    <div class="pager-ctrl">
      <label class="pager-size small">Rows <select class="select" data-size aria-label="Rows per page">${SIZES.map((n) => html`<option value="${n}" ${n === d.size ? html`selected` : ''}>${n}</option>`)}</select></label>
      <nav class="pager-pages" aria-label="Ledger pages">
        <button type="button" class="btn btn-secondary btn-xs" data-page="${d.page - 1}" ${d.page <= 1 ? html`disabled` : ''}>${icon('chevron-left', 16, 2.4)}Previous</button>
        ${pageList(d.page, d.pages).map((p) => (p == null
          ? html`<span class="pager-gap" aria-hidden="true">…</span>`
          : html`<button type="button" class="pager-num" data-page="${p}" ${p === d.page ? html`aria-current="page"` : ''} aria-label="Page ${p}">${p}</button>`))}
        <button type="button" class="btn btn-secondary btn-xs" data-page="${d.page + 1}" ${d.page >= d.pages ? html`disabled` : ''}>Next${icon('chevron-right', 16, 2.4)}</button>
      </nav>
      <span class="meta">Page ${d.page} of ${d.pages}</span>
    </div>`;
}

function totalsStrip(d) {
  const t = d.totals;
  return html`<div class="ledger-total"><span class="eyebrow">Collected</span><span class="strong mono">${money(t.collected)}</span><span class="meta">${plural(t.collectedCount, 'verified payment')}</span></div>
    <div class="ledger-total"><span class="eyebrow">Pending verification</span><span class="strong mono">${money(t.pending)}</span><span class="meta">${plural(t.pendingCount, 'proof')} · not revenue yet</span></div>
    ${t.cancelledAfterPaymentCount ? html`<div class="ledger-total amber"><span class="eyebrow">Cancelled after payment</span><span class="strong mono">${money(t.cancelledAfterPayment)}</span><span class="meta">${plural(t.cancelledAfterPaymentCount, 'booking')} · refunds aren't recorded</span></div>` : ''}`;
}

// ── Screen ────────────────────────────────────────────────────────────────

export function revenueView({ query }) {
  const nowLine = () => `${longDate(isoDate(Date.now()))} · ${clock(Date.now())}`;
  let today = isoDate(Date.now());
  const f = readState(query, today);
  let resources = [];

  const root = frame({
    key: 'revenue',
    eyebrow: nowLine(),
    title: 'Revenue',
    mobileHeader: html`<div class="tb-mobile"><div class="row row-between"><h1 class="m-title">Revenue</h1>${bell({ dark: true })}</div><p class="small light-text" data-clock>${dateLabel(today)} · ${clock(Date.now())}</p></div>`,
    template: html`<div class="page revenue">
      <section class="rev-grid" aria-label="Revenue summary" data-cards>${skeletonRows(1, 'sk-card')}${skeletonRows(1, 'sk-card')}${skeletonRows(1, 'sk-card')}${skeletonRows(1, 'sk-card')}</section>
      <p class="small rev-note" data-note>Collected revenue counts payments staff have verified, on the day they were verified. Proofs still waiting, rejected proofs and unpaid holds are never counted.</p>

      <section class="panel ledger" aria-labelledby="ledger-title">
        <div class="ledger-head">
          <div class="stack stack-4">
            <h2 class="panel-title" id="ledger-title">Booking Ledger</h2>
            <p class="small">A record of bookings and their associated payments, including payment dates, facilities, amounts, and payment status.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-act="export">${icon('download', 18)}Export CSV</button>
        </div>
        <div class="ledger-tools">
          <div class="ledger-search">
            <label class="search-pill">${icon('search', 18)}<input type="search" placeholder="Reference, customer, email or court" aria-label="Search the ledger" data-q value="${f.q}" maxlength="80"></label>
            <button type="button" class="btn btn-text btn-sm" data-act="clear">Clear filters</button>
          </div>
          <div class="filters">
            <select class="select" data-f="resource" aria-label="Facility"></select>
            <select class="select" data-f="type" aria-label="Booking type"><option value="">All types</option><option value="pickleball">Pickleball</option><option value="table_tennis">Table Tennis</option></select>
            <select class="select" data-f="method" aria-label="Payment method"><option value="">All methods</option><option value="gcash">GCash</option><option value="on_site">Paid on site</option></select>
            <select class="select" data-f="status" aria-label="Payment status"><option value="">All statuses</option>${PAY_STATUS.map((s) => html`<option value="${s.key}">${s.label}</option>`)}</select>
            <select class="select only-mobile" data-f="msort" aria-label="Sort">${MOBILE_SORTS.map((s) => html`<option value="${s.key}">${s.label}</option>`)}</select>
          </div>
          <div class="rev-range" role="group" aria-label="Date period">
            <div class="chip-row" role="group" aria-label="Quick date range" data-quick></div>
            <div class="rev-dates" role="group" aria-label="Custom date range">
              <label class="rev-date"><span class="meta">From</span><input class="input" type="date" data-date="from" value="${f.from}" aria-label="Start date"></label>
              <span class="meta rev-dash" aria-hidden="true">–</span>
              <label class="rev-date"><span class="meta">To</span><input class="input" type="date" data-date="to" value="${f.to}" aria-label="End date"></label>
            </div>
          </div>
          <p class="field-error rev-date-error" role="alert" data-date-error hidden></p>
          <p class="small rev-period"><span class="strong" data-range-label>${rangeText(f.from, f.to)}</span> · facility time (Asia/Manila)</p>
        </div>
        <div class="ledger-totals" data-totals></div>
        <div data-ledger>${skeletonRows(5)}</div>
        <div class="pager" data-pager></div>
      </section>
    </div>`,
  });

  const $cards = $('[data-cards]', root);
  const $ledger = $('[data-ledger]', root);
  const $pager = $('[data-pager]', root);
  const $totals = $('[data-totals]', root);
  const $dateError = $('[data-date-error]', root);
  let ledgerSeq = 0;
  let inflight = null;
  let searchTimer = null;
  let dateTimer = null;
  let data = null;

  function syncControls() {
    render($('[data-quick]', root), html`${QUICK.map((r) => html`<button type="button" class="chip" data-range="${r.key}" aria-pressed="${f.range === r.key ? 'true' : 'false'}" title="${r.title}">${r.label}</button>`)}
      <button type="button" class="chip" data-range="custom" aria-pressed="${f.range === 'custom' ? 'true' : 'false'}">${icon('calendar', 16)}Custom</button>`);
    $('[data-range-label]', root).textContent = rangeText(f.from, f.to);
    for (const input of $$('[data-date]', root)) input.value = f[input.dataset.date];
    const res = $('select[data-f="resource"]', root);
    const groups = [
      { activity: 'pickleball', label: 'Pickleball courts' },
      { activity: 'table_tennis', label: 'Table tennis tables' },
    ].filter((g) => !f.type || g.activity === f.type);
    render(res, html`<option value="">All facilities</option>${groups.map((g) => html`<optgroup label="${g.label}">${resources.filter((r) => r.activity === g.activity).map((r) => html`<option value="${r.id}">${r.name}</option>`)}</optgroup>`)}`);
    for (const sel of $$('select[data-f]', root)) {
      sel.value = sel.dataset.f === 'msort' ? `${f.sort}:${f.dir}` : f[sel.dataset.f] || '';
      if (sel.dataset.f === 'msort' && sel.selectedIndex < 0) sel.selectedIndex = 0;
    }
  }

  function syncUrl() {
    const qs = toQuery(f, { forUrl: true });
    history.replaceState(history.state, '', `${REVENUE}${qs ? `?${qs}` : ''}`);
  }

  function setRange(key) {
    f.range = key;
    if (key !== 'custom') [f.from, f.to] = presetRange(key, today);
    $dateError.hidden = true;
    changed();
  }

  /** Any filter change: back to page 1, keep the URL in step, reload the ledger. */
  function changed({ resetPage = true } = {}) {
    if (resetPage) f.page = 1;
    syncControls();
    syncUrl();
    loadLedger();
  }

  async function loadSummary() {
    try {
      const s = await api.get(`${API}/revenue/summary`);
      if (s.today !== today) today = s.today;
      const first = !resources.length;
      resources = s.resources;
      if (first) syncControls();
      render($cards, s.periods.map(summaryCard));
      const pend = s.pendingVerification;
      render($('[data-note]', root), html`Collected revenue counts payments staff have verified, on the day they were verified.
        ${pend.count ? html`<a href="${BASE}/verify">${plural(pend.count, 'proof')} (${money(pend.amount)})</a> still ${pend.count === 1 ? 'waits' : 'wait'} for verification and ${pend.count === 1 ? "isn't" : "aren't"} counted yet.` : 'Nothing is waiting for verification.'}
        Rejected proofs and unpaid holds are never counted.`);
    } catch (err) {
      render($cards, errorState(err, { title: "Revenue totals didn't load" }));
      $('[data-act="retry"]', $cards)?.addEventListener('click', loadSummary);
    }
  }

  async function loadLedger() {
    const seq = ++ledgerSeq;
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const busy = Boolean(data);
    if (busy) {
      $ledger.classList.add('is-loading');
      $ledger.setAttribute('aria-busy', 'true');
    } else render($ledger, skeletonRows(5));
    try {
      const d = await api.get(`${API}/revenue/ledger?${toQuery(f)}`, { signal: inflight.signal });
      if (seq !== ledgerSeq) return;
      data = d;
      if (d.page !== f.page) {
        f.page = d.page; // the server moved us to the last page that exists
        syncUrl();
      }
      paintLedger(d);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== ledgerSeq) return;
      data = null;
      render($totals, '');
      render($pager, '');
      render($ledger, errorState(err, { title: "The ledger didn't load" }));
      $('[data-act="retry"]', $ledger)?.addEventListener('click', loadLedger);
    } finally {
      if (seq === ledgerSeq) {
        $ledger.classList.remove('is-loading');
        $ledger.removeAttribute('aria-busy');
      }
    }
  }

  function paintLedger(d) {
    const thisYear = today.slice(0, 4);
    render($totals, totalsStrip(d));
    if (!d.rows.length) {
      render($pager, '');
      const filtered = f.q || f.resource || f.type || f.method || f.status;
      render($ledger, html`<div class="empty empty-center"><span class="tile blue lg">${icon('banknote', 26)}</span>
        <p class="empty-title">No revenue records found for the selected period</p>
        <p class="empty-body">${filtered ? 'Nothing matches these filters between' : 'No payments were submitted or verified between'} ${d.range.label.replace(' – ', ' and ')}. Try a longer period${filtered ? ' or clear the filters' : ''}.</p>
        ${filtered ? html`<button type="button" class="btn btn-secondary btn-md" data-act="clear">Clear filters</button>` : ''}</div>`);
      return;
    }
    const sortTh = (c) => {
      const active = f.sort === c.key;
      const ariaSort = active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const glyph = active ? (f.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort';
      return html`<th aria-sort="${ariaSort}" class="${c.right ? 'r' : ''}"><button type="button" class="th-sort${active ? ' active' : ''}" data-sort="${c.key}">${c.label}${icon(glyph, 14, 2.4)}</button></th>`;
    };
    render($ledger, html`<div class="table-wrap only-desktop"><table class="grid ledger-table">
        <caption class="sr-only">Booking ledger, ${d.range.label}. Sorted by ${COLUMNS.find((c) => c.key === f.sort)?.label}, ${f.dir === 'asc' ? 'ascending' : 'descending'}.</caption>
        <thead><tr>${COLUMNS.map(sortTh)}<th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${d.rows.map((r) => tableRow(r, thisYear))}</tbody>
      </table></div>
      <div class="stack stack-8 only-mobile ledger-cards">${d.rows.map((r) => mobileCard(r, thisYear))}</div>`);
    render($pager, pager(d));
  }

  /** One part of the CSV (the server sends at most 1,000 rows per request). */
  async function exportPart(qs, part) {
    const res = await fetch(`${API}/revenue/export?${qs}&part=${part}`, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) {
      showSessionExpired();
      throw new Error('Your session ended. Sign in again, then export.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || "The export didn't work. Please try again.");
    }
    return res;
  }

  /** Fetches every part and checks nothing changed in between (else starts over, twice at most). */
  async function exportText(qs, btn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await exportPart(qs, 1);
      const parts = Number(first.headers.get('x-export-parts')) || 1;
      const version = first.headers.get('x-export-version');
      const name = /filename="([^"]+)"/.exec(first.headers.get('content-disposition') || '')?.[1] || 'le-spinners-revenue.csv';
      const chunks = [(await first.text()).replace(/^\uFEFF/, '')];
      let changed = false;
      for (let p = 2; p <= parts && !changed; p++) {
        busyText(btn, `Exporting… ${p} of ${parts}`);
        const res = await exportPart(qs, p);
        if (res.headers.get('x-export-version') !== version) changed = true;
        else chunks.push(await res.text());
      }
      if (!changed) return { name, chunks, rows: Number(first.headers.get('x-export-rows')) || 0 };
    }
    throw new Error('Payments changed while the file was being built. Export again in a moment.');
  }

  async function exportCsv(btn) {
    if (btn.disabled) return;
    setBusy(btn, true, 'Exporting…');
    try {
      const { name, chunks, rows } = await exportText(toQuery(f, { paged: false }), btn);
      // A byte-order mark so spreadsheet apps read the file as UTF-8 (₱, ñ).
      const blob = new Blob([String.fromCharCode(0xfeff), ...chunks], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.setAttribute('data-native', '');
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast('Ledger exported', { sub: `${plural(rows, 'record')} · same filters and order as the table` });
    } catch (err) {
      toast(err.message || "The export didn't work.", { type: 'error' });
    } finally {
      setBusy(btn, false);
    }
  }

  // ── Events ──
  on(root, 'click', '[data-range]', (_e, btn) => {
    if (btn.dataset.range === 'custom') {
      f.range = 'custom';
      syncControls();
      syncUrl();
      $('[data-date="from"]', root).focus();
      return;
    }
    setRange(btn.dataset.range);
  });
  on(root, 'change', '[data-date]', () => {
    clearTimeout(dateTimer);
    dateTimer = setTimeout(() => {
      const from = $('[data-date="from"]', root).value;
      const to = $('[data-date="to"]', root).value;
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return;
      if (from > to) {
        $dateError.hidden = false;
        $dateError.textContent = 'The start date must be on or before the end date.';
        return;
      }
      $dateError.hidden = true;
      Object.assign(f, { range: 'custom', from, to });
      changed();
    }, 350);
  });
  on(root, 'change', 'select[data-f]', (_e, sel) => {
    const k = sel.dataset.f;
    if (k === 'msort') {
      [f.sort, f.dir] = sel.value.split(':');
      return changed();
    }
    f[k] = sel.value;
    if (k === 'type' && f.resource && !resources.some((r) => r.id === f.resource && r.activity === f.type)) f.resource = '';
    changed();
  });
  on(root, 'input', '[data-q]', (_e, el) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const v = el.value.trim().slice(0, 80);
      if (v === f.q) return;
      f.q = v;
      changed();
    }, 300);
  });
  on(root, 'click', '[data-sort]', (_e, btn) => {
    const key = btn.dataset.sort;
    if (f.sort === key) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
    else {
      f.sort = key;
      f.dir = key === 'date' || key === 'amount' || key === 'duration' ? 'desc' : 'asc';
    }
    changed();
  });
  on(root, 'click', '[data-page]', (_e, btn) => {
    const p = Number(btn.dataset.page);
    if (!data || btn.disabled || !Number.isInteger(p) || p < 1 || p > data.pages || p === f.page) return;
    f.page = p;
    changed({ resetPage: false });
    $('#ledger-title', root).scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  on(root, 'change', '[data-size]', (_e, sel) => {
    f.size = SIZES.includes(Number(sel.value)) ? Number(sel.value) : 10;
    changed();
  });
  on(root, 'click', '[data-act="clear"]', () => {
    Object.assign(f, { q: '', resource: '', type: '', method: '', status: '' });
    $('[data-q]', root).value = '';
    changed();
  });
  on(root, 'click', '[data-act="export"]', (_e, btn) => exportCsv(btn));

  syncControls();
  syncUrl();
  loadSummary();
  loadLedger();
  const stopSummary = poll(loadSummary, 60_000);
  const tick = setInterval(() => {
    for (const el of $$('#topbar .tb-eyebrow')) el.textContent = nowLine();
    for (const el of $$('#topbar [data-clock]')) el.textContent = `${dateLabel(isoDate(Date.now()))} · ${clock(Date.now())}`;
  }, 30_000);
  return () => {
    stopSummary();
    clearInterval(tick);
    clearTimeout(searchTimer);
    clearTimeout(dateTimer);
    if (inflight) inflight.abort();
  };
}
