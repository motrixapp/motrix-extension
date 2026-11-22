# Firefox early takeover

The blocking webRequest listener has two phases. It holds response headers only
for a bounded, read-only preflight (1.5 seconds). It checks configuration,
endpoint availability, response metadata, and the same automatic takeover policy
as the native download adapter. Failure or timeout returns `{}` without starting
any replacement transfer. A successful preflight returns `{ cancel: true }` and
schedules delivery in a later task; it does not await a confirmation form inside
the blocking listener.

The independent `motrix.earlyTakeover` setting defaults to enabled. The normal
`motrix.takeoverConfig.enabled` setting defaults to disabled through the existing
configuration store. Startup waits for the initial read within the preflight
budget; a newer storage event must not be overwritten by that read. Settings and
endpoint changes fence pending delivery.

The blocking listener only claims direct mode requests with a verified public
replay source. Confirmation mode passes the response through to the DownloadItem
controller. This controller pauses an eligible original ID, resumes it on browser
choice or pre-submit dismissal, and cancels it on explicit cancel or acceptance.
Firefox can resume via a Range request. Cloud-drive and unclassified URLs continue
without pausing, probing or submitting. Old drafts from an already-cancelled
response still carry their explicit browser replay marker.

## Ownership after cancellation

| Outcome | Owner/action |
| --- | --- |
| Direct accepted | Motrix; presentation failure cannot replay |
| Direct unknown | Motrix may own it; do not replay |
| Direct browser | Handoff already replayed; do not replay again |
| Direct skipped/failed | Attempt browser replay once |

Browser fallback caches its attempt, including rejection. Requests without a tab
and extension-initiated requests are excluded from early interception. The native
adapter also ignores its own extension's DownloadItems. There is no URL-based
TTL: two user downloads of the same URL are separate operations.

PDF and other inline responses are left alone unless explicitly attachments.
Only GET 200 main-frame, sub-frame attachment, or binary object responses qualify;
media, POST, and other request types stay on the existing path.

## Validation

- `src/background/interception/__tests__/webRequestEarly.test.ts` covers actual
  policy and handoff code, startup/live switches, cancellation before delivery,
  browser fallback ownership, unknown outcomes, and repeated URLs.
- Confirmation tests cover explicit cancellation, resume of the original ID, and
  recovery of editing, submitted and accepted download leases after a restart.
- `node scripts/verify-firefox-takeover.mjs` registers **both** production Firefox
  adapters with real webRequest/download APIs and a local HTTP server. It checks
  native download counts, GET and Range requests, a quiet confirmation interval, explicit
  browser resume, failed/unknown submission, missing Content-Type, defaults,
  exclusions, size rules, PDF, browser-owned downloads, and the kill switch.
  Motrix is simulated. The driver clicks the production confirmation form in the
  fixture page and exercises the production confirmation service and actions.
- Existing CI executes that script on Firefox 143.0 and latest.

Both browser families preserve the original download when the entry URL itself
contains a credential, it previously served an HTML page in the same tab, or the
request needs browser authentication or cookies outside the entry URL's scope.
A public entry URL can still be handed off when it redirects to a newly signed
CDN URL. Downloads served from a page-created Blob stay with the browser.

Handoff and browser fallback open a new request to the entry URL. Use a site
exclusion for sources that enforce single use without a detectable signal.
