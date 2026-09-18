# Store submission

The extension is already listed in Chrome Web Store, Microsoft Edge Add-ons,
and Firefox AMO. The **Submit browser extension to stores** workflow updates
these existing listings using `publish-browser-extension`, the same publishing
tool used by `wxt submit`. CRXJS remains the build system.

## One-time repository configuration

Configure these repository **Actions variables** under Settings → Secrets and
variables → Actions → Variables:

| Variable | Value and location |
| --- | --- |
| `CHROME_PUBLISHER_ID` | Publisher ID from the Chrome Web Store developer dashboard's publisher settings. |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | Email of the Google Cloud service account linked to that publisher. |
| `EDGE_PRODUCT_ID` | Product GUID from the extension's Partner Center overview/identity page. This is not the public Edge extension ID. |
| `EDGE_CLIENT_ID` | Client ID from Partner Center → Microsoft Edge → Publish API. |

Configure these repository **Actions secrets**:

| Secret | Value and location |
| --- | --- |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | The `private_key` field from the service account JSON key, including the PEM header and footer. Both real newlines and JSON-style `\n` escapes are accepted. |
| `EDGE_API_KEY` | API key from Partner Center → Microsoft Edge → Publish API. Record its expiry and rotate it before expiry. |
| `FIREFOX_JWT_ISSUER` | AMO API key/issuer from the Firefox API credentials page, often `user:...:...`. |
| `FIREFOX_JWT_SECRET` | AMO API secret from the same page. |

The submission script supplies the existing Chrome extension ID
`lggbokfckofcgjndaboioakcmincinpo` and Firefox ID
`motrix-extension@motrix.app`; those are not additional repository settings.
Each job receives only its own store credentials. There is no additional
GitHub environment or approval setup required by this workflow.

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
`gh variable set NAME --repo motrixapp/motrix-extension --body VALUE`.
For the Chrome private key, read its field from the downloaded service-account
JSON directly into the secret, preserving the multiline PEM value:

```bash
jq -r '.private_key' service-account.json | \
  gh secret set CHROME_SERVICE_ACCOUNT_PRIVATE_KEY --repo motrixapp/motrix-extension
```

For the remaining secrets, run these commands and enter each value at the
hidden prompt:

```bash
gh secret set EDGE_API_KEY --repo motrixapp/motrix-extension
gh secret set FIREFOX_JWT_ISSUER --repo motrixapp/motrix-extension
gh secret set FIREFOX_JWT_SECRET --repo motrixapp/motrix-extension
```

Do not paste secrets into workflow YAML, release notes, or committed files.
The publisher supports `.env.submit` for its standalone CLI; the workflow uses
repository settings instead and does not need that file.

## Submit an existing release

1. Create the release with **Release browser extension** and wait for its ZIPs
   and `SHA256SUMS.txt` to become available.
2. Open Actions → **Submit browser extension to stores** → Run workflow.
3. Keep the workflow branch as `main`, enter the published `vX.Y.Z` release tag,
   select `all`, `chrome`, `edge`, or `firefox`, and run it.

`dry_run` defaults to `false`: running this workflow uploads and submits the
selected stores for review. Credentials are validated before their store's
upload where supported. Chrome uses normal review and publication after
approval; it does not cancel an existing pending review or request a review
exemption. Firefox uses the public `listed` channel and retains desktop and
Android compatibility.

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
and source archives missing the lockfile or referenced pnpm patches. All three
ZIPs are required even when selecting one store. Submission jobs recheck the
same bytes before calling the store API. Only code from the selected `main`
workflow revision is executed; code inside release archives is not executed.

To check initial setup without uploading:

```bash
gh workflow run submit-stores.yml --repo motrixapp/motrix-extension \
  --ref main -f tag=v0.1.12 -f store=all -f dry_run=true
```

Chrome and Firefox dry runs check authentication against their store APIs.
**The upstream Edge adapter does not call an authentication endpoint in dry-run
mode.** An Edge dry run only checks local artifacts and configuration; it cannot
confirm that the API key is valid. Dry runs also cannot prove that an uploaded
package will pass store validation or review.

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

Successful submission means the API accepted the submission, not that review
has finished or that the version is publicly available. A failed or timed-out
job may already have uploaded a package or submitted a version. Inspect the
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

Package updates are automated. Listing screenshots, descriptions, privacy
declarations, and responses to reviewers remain separate store tasks. In
particular, Edge's Update API does not provide listing-metadata update endpoints.

## Local development

`publish-browser-extension` and the ZIP reader are exact dev dependencies in the
lockfile. The wrapper uses the publisher's public per-store adapters so a
failure throws normally and the job can write its summary; the upstream
multi-store `submit()` exits the process on failure. Only the explicitly
selected store is configured. Changes to the dependencies or workflow should pass:

```bash
pnpm exec vitest run src/__tests__/store-submission.test.ts
pnpm lint
pnpm typecheck
actionlint .github/workflows/submit-stores.yml
```

The regression tests exercise release identity/checksum failures, source patch
requirements, the installed publisher's configuration schema, and the boundary
that prevents upload when verification fails. They use a fake publisher and do
not contact store APIs.
