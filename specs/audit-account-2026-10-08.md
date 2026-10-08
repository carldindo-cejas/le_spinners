# Read-only account, staging and storage evidence — October 8, 2026

Reviewer: Codex integrity-audit agent. Existing OAuth was captured privately with Wrangler disk logging and telemetry disabled. No credential values, email addresses, customer rows, object keys or image bodies were printed or retained. No Cloudflare resources were created, changed or used as test targets. Metadata discovery does not authorize use of any existing resources.

## Actual resource association and G01

[scripts/audit-account-metadata.mjs](../scripts/audit-account-metadata.mjs) completed **13 metadata GETs at 05:38 Asia/Manila**. Aggregate/name-only evidence is `.wrangler/audit-account-evidence.json`. The documented [Worker list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/), paginated [D1 list](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/) and paginated [R2 bucket list](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/) were read without accessing application data.

The final read-only account refresh completed **October 8 at 13:09:10 Asia/Manila (`2026-10-08T05:09:10.585Z`)**, again with 13 metadata GETs, zero resource mutations, zero object-content requests and zero customer-data queries. Independent review of the refreshed receipt reconfirms all resource counts and associations below, production Worker version 13 at 100% with matching DB/R2/APP_ORIGIN bindings, production-only app service environments, no verified isolated staging map, the same D1 storage snapshot and the subscription API's HTTP 403/code 10000 gap. No collection errors were recorded; billing access remains an explicitly recorded optional metadata gap. This refresh does not imply an approved account plan or staging setup.

| Inventory | Actual result | App association established |
| --- | --- | --- |
| Worker scripts | Seven scripts; complete documented unpaginated response | Only `le-spinners` matched app names |
| D1 databases | Six databases; reported total matched the complete first page | Only `le-spinners`, UUID `359085b7-5fbe-4d85-9db8-7ab2dc39ee57`, matched app names |
| Default-jurisdiction R2 buckets | Four buckets; keyset listing ended on an explicit empty second page | Only `le-spinners-proofs` matched app names |
| EU/US R2 buckets | Zero in each complete first-page response | None |
| `le-spinners` service environments | Actual environment inventory returned `production` only; default also `production` | No separate app service environment reported |
| Local Wrangler environments | `env` has no named entries | No local staging resource/origin mapping |

The other six Workers, five databases and three buckets were not assumed to be this application's staging resources, and unrelated names were not retained. **G01 remains Blocked: there is no verified, approved isolated staging map.** This is an observed association gap, rather than merely an unchecked account inventory. A differently named setup needs an operator-provided association and binding review before use.

Exact operator action: identify an approved staging Worker/environment, separate D1 UUID and private R2 bucket, distinct secrets, exact HTTPS APP_ORIGIN and controlled mail sender/recipient; record their association and review isolation. If no such setup exists, the operator must establish it and authorize its synthetic tests. This review did not create resources, rotate credentials, subscribe to plans, send mail or infer an approved recipient.

## Refreshed production deployment and configuration

Current deployment metadata reports `4e69d3c0-dacb-49ee-85fd-ba0a717e8096`, created October 7 at 14:07:47 UTC. Active Worker version remains **`fd7a20f6-0819-4cf6-8c66-22fb4434d675`, version number 13, at 100%**. Read-only [version metadata](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/) reports:

| Property | Actual metadata |
| --- | --- |
| Compatibility date | `2026-09-01` |
| Worker usage model | `standard` |
| APP_ORIGIN | `https://le-spinners.cejascarldindo.workers.dev`; matches local config |
| DB | UUID `359085b7-5fbe-4d85-9db8-7ab2dc39ee57`; matches local config |
| PROOFS | `le-spinners-proofs`; matches local config |
| Secret names | `FILE_SIGNING_SECRET`, `PASSWORD_PEPPER`; no `RESEND_API_KEY` |

Secret values/custody/rotation, controlled delivery, authenticated device acceptance and candidate asset parity are separate requirements. The source corrections in the current candidate remain absent from this deployed version; deployment metadata refresh is evidence of the actual version, not a new deployment or release pass.

## Storage snapshot and plan evidence

Production D1 metadata at 05:38, reconfirmed by the 13:09 refresh, reports **544,768 file bytes and 28 tables**, database version `production`, and read replication `disabled`. No maximum database size or billing/CPU/request quota was directly reported.

The refreshed [R2 object metadata inventory](audit-integrity-2026-10-07.md) at 05:34 reports **nine actual objects: eight proofs and one current QR**. All objects are tracked and referenced, and proof size/type metadata matches D1; missing/untracked/unreferenced/extra namespace counts are zero. Stored bytes are **11,632,894 total = 11,574,261 proof bytes + 58,633 QR bytes**, with zero unknown object sizes. Two SELECT snapshots were stable, two metadata listing pages completed, and zero image bodies were downloaded. Evidence is `.wrangler/audit-r2-evidence.json`. Sizes describe stored objects at this snapshot, not image-body validation or billed storage history.

The [Workers account settings](https://developers.cloudflare.com/api/resources/workers/subresources/account_settings/methods/get/) GET returned `default_usage_model=standard`, `green_compute=false`. The [account entitlements](https://developers.cloudflare.com/api/resources/accounts/subresources/entitlements/methods/list/) GET returned 65 features; related explicit values were `r2.enabled=true`, `r2.infrequent_access=true`, `r2.fedramp=false`. It reported no Workers/D1 budget limits. The [subscriptions GET](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/), which requires Billing Read/Write, returned **HTTP 403, code 10000** under existing OAuth.

**The account's actual free/paid plan, billable usage, quotas and cost headroom remain unverified.** Exact operator action: supply redacted current account-plan/quota evidence from the dashboard or an authorized Billing Read metadata view, actual billed D1/R2/Worker usage, and the accepted monthly budget/headroom targets. Capacity/cost acceptance cannot be inferred from a usage-model string, small stored byte count or enabled R2 features. L01/G07 remain blocked on their explicit approval and intended-plan evidence requirements.

## Helper validation

`node --check` passed for `scripts/audit-account-metadata.mjs`, `scripts/audit-r2-metadata.mjs` and `scripts/audit-integrity-live.mjs`; scoped `git diff --check` passed. The R2 command now exits nonzero for incomplete or failed referenced-metadata acceptance and records a separate reconciliation result covering all missing tracked, orphan/untracked, invalid and extra namespace candidates. The actual refreshed snapshot passes both flags. No heavy test suite ran during the active local capacity soak.

Eleven lightweight synthetic controls against the actual helper expressions passed: empty/normal/negative/unknown/unsafe/overflow byte aggregation, success exit status and failure for incomplete/reference/reconciliation/error outcomes. The retained actual snapshot's proof-plus-QR byte sum and zero exit status also matched. Evidence is `.wrangler/audit-metadata-controls.json`; these controls made no network requests.
