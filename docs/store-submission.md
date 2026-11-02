# Store submission

The extension is already listed in Chrome Web Store, Microsoft Edge Add-ons,
and Firefox AMO. The **Submit browser extension to stores** workflow updates
these existing listings using `publish-browser-extension` for Chrome and
Firefox and a dedicated Edge Publish API client. CRXJS remains the build system.

## One-time repository configuration

First apply the [repository protection configuration](../.github/security/README.md).
Create `store-chrome`, `store-edge`, and `store-firefox` under Settings →
Environments. Each environment must allow only the `main` branch, require
approval by `agalwood`, allow self-review for the solo-maintainer profile, and
disable administrator bypass. Both dry runs and live submissions use these gates.

Configure the following **environment variables** under Settings → Environments
→ the corresponding store → Environment variables (Chrome settings in
`store-chrome`, Edge settings in `store-edge`):

| Variable | Value and location |
| --- | --- |
| `CHROME_PUBLISHER_ID` | Publisher ID from the Chrome Web Store developer dashboard's publisher settings. |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | Email of the Google Cloud service account linked to that publisher. |
| `EDGE_PRODUCT_ID` | Product GUID from the extension's Partner Center overview/identity page. This is not the public Edge extension ID. |
| `EDGE_CLIENT_ID` | Client ID from Partner Center → Microsoft Edge → Publish API. |

Configure these **environment secrets** in the matching store environment:

| Secret | Value and location |
| --- | --- |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | The `private_key` field from the service account JSON key, including the PEM header and footer. Both real newlines and JSON-style `\n` escapes are accepted. |
| `EDGE_API_KEY` | API key from Partner Center → Microsoft Edge → Publish API. Record its expiry and rotate it before expiry. |
| `FIREFOX_JWT_ISSUER` | AMO API key/issuer from the Firefox API credentials page, often `user:...:...`. |
| `FIREFOX_JWT_SECRET` | AMO API secret from the same page. |

The submission script supplies the existing Chrome extension ID
`lggbokfckofcgjndaboioakcmincinpo` and Firefox ID
`motrix-extension@motrix.app`; those are not additional settings.
Each job binds to `store-${store}` and receives only its own store credentials.
Do not also store these credentials at repository or organization scope:
that would leave them accessible outside the environment gate. Creating an
environment without reviewer and branch rules does not secure it.

For Chrome, enable the **Chrome Web Store API** in the Google Cloud project,
create a service account, and link its email in the Chrome Web Store developer
dashboard. Creating a service account alone does not grant store access.
The script explicitly uses API v2 and its service-account authentication.

For Edge, enable the current Publish API experience and create its Client ID
and API key. The older OAuth client-secret/access-token-URL setup is not used.

Setup references:

- [Chrome service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Microsoft Edge Update API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
- [Firefox API credentials](https://addons.mozilla.org/developers/addon/api/key/)
- [Firefox API authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)

With `gh`, set nonsecret values using
`gh variable set NAME --repo motrixapp/motrix-extension --env store-chrome --body VALUE`.
Use `--env store-edge` for Edge variables. For the Chrome private key, read its
field from the downloaded service-account JSON directly into the secret,
preserving the multiline PEM value:

```bash
jq -r '.private_key' service-account.json | \
  gh secret set CHROME_SERVICE_ACCOUNT_PRIVATE_KEY --repo motrixapp/motrix-extension --env store-chrome
```

For the remaining secrets, run these commands and enter each value at the
hidden prompt:

```bash
gh secret set EDGE_API_KEY --repo motrixapp/motrix-extension --env store-edge
gh secret set FIREFOX_JWT_ISSUER --repo motrixapp/motrix-extension --env store-firefox
gh secret set FIREFOX_JWT_SECRET --repo motrixapp/motrix-extension --env store-firefox
```

Do not paste secrets into workflow YAML, release notes, or committed files.
The publisher supports `.env.submit` for its standalone CLI; the workflow uses
environment settings instead and does not need that file.

## Submit an existing release

1. Create the release with **Release browser extension** and wait for its ZIPs
   and `SHA256SUMS.txt` plus their signed attestations to become available.
   Release tags must point to commits already on main. For a manual
   release build, run `release.yml` with `--ref vX.Y.Z -f tag=vX.Y.Z`; the workflow
   revision must be the tag itself, not main.
2. Open Actions → **Submit browser extension to stores** → Run workflow.
3. Keep the workflow branch as `main`, enter the published `vX.Y.Z` release tag,
   select `all`, `chrome`, `edge`, or `firefox`, and run it.

`dry_run` defaults to `true` (no upload). Select `false` explicitly to upload and
submit for review. After preparation succeeds, approve the selected store
environments through **Review deployments**. Approval is required for dry runs
too; it is not performed automatically by the workflow. Credentials are validated
before their store's upload where supported. Chrome uses normal review and publication after
approval; it does not cancel an existing pending review or request a review
exemption. Firefox uses the public `listed` channel and retains desktop and
Android compatibility.

For Edge, a live run automatically uploads the package, waits for upload
validation, submits the draft for review, and waits for the submission operation
to report `Succeeded`. No separate Partner Center submit action is needed when
the API succeeds. This confirms that a submission was created; Microsoft still
needs to review it before the store version changes.

The same operation through `gh` (replace the example with the release tag):

```bash
gh workflow run submit-stores.yml --repo motrixapp/motrix-extension \
  --ref main -f tag=v0.1.12 -f store=all -f dry_run=false

gh run list --repo motrixapp/motrix-extension --workflow submit-stores.yml --limit 5
gh run watch RUN_ID --repo motrixapp/motrix-extension --exit-status
```

The workflow is deliberately separate from building a release, so a failed
store can be retried without rebuilding or publishing another GitHub Release.
Pushing a tag or publishing a GitHub Release does not automatically submit it
to stores. The workflow file must first exist on the repository's default
branch before GitHub exposes manual dispatch.

## Verification and dry runs

The preparation job downloads exactly these assets for the requested version:

- `motrix-extension-X.Y.Z-chrome-edge.zip`
- `motrix-extension-X.Y.Z-firefox.zip`
- `motrix-extension-X.Y.Z-source.zip`
- `SHA256SUMS.txt`

It rejects draft/prerelease releases, mismatched tags, absent or duplicate
checksums, altered ZIPs, wrong manifest versions, a different Firefox identity,
and source archives missing the lockfile or referenced pnpm patches. It also verifies
GitHub-signed provenance for all three ZIPs and the checksum manifest, requiring
the upstream repository, `release.yml`, the exact release tag and commit, and a
GitHub-hosted runner. The release commit must belong to main's history. All three
ZIPs are required even when selecting one store. Submission jobs recheck the
same bytes and provenance after environment approval, including detecting tag
changes since preparation, before exposing store credentials to the submit step.
Only code from the selected `main` workflow revision is executed; code inside release archives is not executed.

There is no legacy checksum-only fallback. Releases built before this hardening,
including v0.1.11, lack the required attestations. Build a new version from the
updated main branch; do not rewrite an old protected tag to bypass this check.

To check initial setup without uploading:

```bash
gh workflow run submit-stores.yml --repo motrixapp/motrix-extension \
  --ref main -f tag=v0.1.12 -f store=all -f dry_run=true
```

Chrome and Firefox dry runs check authentication against their store APIs.
**Edge dry runs do not call the store API.** An Edge dry run only checks local
artifacts and configuration; it cannot confirm that the API key is valid. Dry
runs also cannot prove that an uploaded package will pass store validation or review.

The source ZIP is checked for necessary build inputs, not rebuilt by the
submission job. When changing build tooling, verify that the source ZIP can be
extracted and built with the Node/pnpm versions in `release.yml`, using
`pnpm install --frozen-lockfile` and `pnpm build:firefox`, as described in README.
The full source tree, lockfile, workspace configuration, and patches must remain
in the release source archive for AMO review.

## Results and partial failures

Each store gets an independent job and job summary; one failure does not cancel
the other stores. Submissions to the same store are serialized across versions,
and an active submission is never automatically cancelled. GitHub concurrency
is not an unlimited queue: avoid dispatching several pending releases at once.

For Edge, HTTP `202 Accepted` alone never makes the job pass. Both the upload and
submission operations must report `Succeeded`. The client polls every 5 seconds,
allows up to 8 minutes per operation (including its initial POST), and bounds
each HTTP request to 60 seconds. These limits leave time within the 20-minute
submission job for setup, verification and reporting errors. Logs identify each
operation ID. A failed operation prints the API response, including `message`,
`errorCode` and `errors`, in both the log and Actions job summary. Missing operation
IDs, unexpected responses, HTTP/network failures and timeouts also fail the job.
API credentials are redacted from Edge errors. POST requests are never retried
automatically because the server may already have accepted them.

See [Edge operation states and errors](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference#check-the-publishing-status).

Successful submission does not mean that review has finished or that the version
is publicly available. A failed or timed-out job may already have uploaded a
package or submitted a version. Inspect the
store dashboard before retrying, especially after a network error. There is no
cross-store rollback and the tool does not guarantee idempotent retries.

After checking the store's state, select only the failed store, for example:

```bash
gh workflow run submit-stores.yml --repo motrixapp/motrix-extension \
  --ref main -f tag=v0.1.12 -f store=edge -f dry_run=false
```

If a version is already accepted or under review, do not re-upload it blindly.
Wait for the existing submission or use the store's own controls. The workflow
does not automatically bump versions, cancel review, or resubmit all stores.

For Firefox, **Check Firefox submission status** reads an existing version
without uploading anything. Run it from `main` with the release tag and approve
`store-firefox`. It reports review status, source presence, and compatibility.
This is useful after a partial failure: v0.1.12 was created with sources before
the old publisher configuration attempted an unnecessary Android compatibility
override. Compatibility now comes only from the package manifest.

```bash
gh workflow run check-firefox-version.yml --repo motrixapp/motrix-extension \
  --ref main -f tag=v0.1.12
```

Package updates are automated. Listing screenshots, descriptions, privacy
declarations, and responses to reviewers remain separate store tasks. In
particular, Edge's Update API does not provide listing-metadata update endpoints.

## Local development

`publish-browser-extension` and the ZIP reader are exact dev dependencies in the
lockfile. Chrome and Firefox use the publisher's public per-store adapters so a
failure throws normally and the job can write its summary; the upstream
multi-store `submit()` exits the process on failure. Edge uses
`scripts/edge-store.mjs` because the upstream adapter does not check the
asynchronous submission result. Only the explicitly selected store is configured.
Changes to the dependencies or workflow should pass:

```bash
pnpm exec vitest run src/__tests__/store-submission.test.ts
node --test scripts/__tests__/edge-store.test.mjs
pnpm lint
pnpm typecheck
actionlint .github/workflows/*.yml
```

The regression tests exercise release identity/checksum failures, source patch
requirements, the installed publisher's configuration schema, and the boundary
that prevents upload when verification fails. Mock Edge API responses exercise
the upload-to-review sequence, asynchronous failures, operation IDs, timeouts,
credential redaction, and the CLI exit code and Actions summary. Tests do not
contact store APIs.
