# Motrix Browser Extension

English | [简体中文](./README.zh-CN.md)

Send downloads from your browser to [Motrix](https://motrix.app), then check their progress and manage the tasks from the same small window. The extension can also find video, audio, and images loaded by the current page so you can choose what to save.

I think of it as a bridge between the browser and Motrix. The browser is good at finding resources; Motrix is good at downloading them reliably. That division of labor is simple, and it feels right in daily use.

> [!IMPORTANT]
> `v0.1.0` is still in development and has not been released publicly. It is not ready to be your everyday download tool. YouTube support, in particular, is only placeholder code for integration testing and cannot perform a real download. The Chrome Web Store build removes that code entirely.

## What you can do

- Right-click a link and choose **Download with Motrix**.
- Paste an HTTP, HTTPS, or magnet link to create a task.
- Let Motrix take over eligible browser downloads, with a size threshold and a list of sites to leave alone.
- Scan resources already loaded by the current page, filter them by video, audio, or image, and submit a selection in one batch.
- Check speeds and task status in the extension. You can pause, resume, or remove tasks and, when supported, ask Motrix to reveal the downloaded file.
- Connect to the Motrix App on this computer or save and switch between several remote Motrix Servers.

This is useful, but websites are messy. Login state, expiring URLs, hotlink protection, DRM, and each site's player design can all change the result. The extension keeps the request details a download may need, but it does not bypass DRM and cannot promise that every resource visible on a page can be downloaded on its own.

## Before you start

You will need:

- Chrome 120 or later, or Firefox 128 or later;
- a Motrix App or Motrix Server compatible with the current MDXP / MBP1 protocol;
- for a local connection, a running Motrix App with its browser integration component installed correctly.

There is no store release or stable installer yet. Early testing requires a source build. If you simply want a quiet, dependable download tool, I would wait for the first public release. It will save you a fair amount of friction.

<details>
<summary>Install a test build from source</summary>

You need Node.js 22.13 or later and pnpm 11.

```bash
pnpm install
pnpm build:chromium
pnpm build:firefox
```

Chrome: open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/chromium/`.

A Chrome development build needs one more setup step. The extension has not been published to the Chrome Web Store, so the ID assigned to a locally loaded copy is not in Motrix's built-in trust list. Without adding it, Motrix rejects the connection before it shows a pairing code.

1. Stay on `chrome://extensions`, find Motrix Extension, and copy the ID shown on its card.
2. In Motrix, open **Settings → Integration → Browser extensions** and make sure **Send downloads from browser extensions** is enabled.
3. Expand **Trusted extensions**, choose **Add extension**, paste the ID, select **Chrome / Edge**, and choose **Add**. The label is optional.
4. Return to the extension, connect to Motrix again, and complete pairing when prompted.

Only add the ID you copied from your browser's extension-management page. Chrome may assign a different ID if you move the unpacked build to another directory or install it on another computer. If that happens, remove the old entry from Motrix and add the new one.

Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Firefox removes temporary extensions when it restarts.

</details>

## Connect for the first time

### Motrix on this computer

1. Start the Motrix App.
2. Select the Motrix icon in the browser toolbar, then choose **Connect**.
3. If the extension finds more than one Motrix instance, select the one you want.
4. Enter the eight-character pairing code shown by Motrix.

After pairing, the extension stores a credential that belongs only to that Motrix installation. It will usually reconnect without asking for another code. If you revoke the pairing in Motrix, the browser must be authorized again.

### A remote Motrix Server

Open **Settings → Integration**, add a name and a `ws://` or `wss://` address, then complete pairing.

Use `wss://` for remote connections when possible. Task content still has application-level encryption over `ws://`, but plain WebSocket cannot reliably prove the server's identity and may expose connection metadata. Once a connection crosses the internet or a NAS reverse proxy, that difference stops being academic.

Pairing credentials and data permissions are isolated per Server. Pairing proves which Server you reached; it does not give that Server permission to receive browser data. You must enable **Remote downloads** separately. Cookies and page-derived request headers start disabled and must also be granted per Server.

## Three ways to download

### Right-click a link

Right-click a download link on a page and choose **Download with Motrix**. This is the most direct route, and automatic takeover does not need to be enabled.

The remote Server policy currently blocks right-click handoff. When a remote Server is selected, create the task manually in the extension or submit it from the **Sniffer** tab instead.

### Create a task manually

Once Motrix is connected, open the **Tasks** tab and select the plus button in the upper-right corner. Paste one HTTP, HTTPS, or `magnet:?` address. The current version accepts one address at a time.

### Choose resources from the page

Open the **Sniffer** tab. It lists video, audio, and images loaded by the current page; images can be narrowed further by format, dimensions, and file size. On a page that uses lazy loading, scroll through it or start playback before selecting **Scan again**. The results are usually more complete.

One distinction matters here: finding a resource does not guarantee a successful download. Some URLs expire quickly. Some video needs separate audio and video tracks that Motrix must merge with ffmpeg, while other media is protected by DRM. The extension marks selections the current backend cannot handle instead of pretending that the task was accepted.

## Browser download takeover

When **Takeover** is on, eligible browser downloads are sent automatically to the local Motrix App. A remote Server currently accepts only tasks that you create or submit from the extension; automatic takeover and right-click handoff are blocked. That is conservative, but I think the extra deliberate step is sensible when browser data may cross devices.

The settings let you define:

- a minimum file size, below which the browser keeps the download;
- a denylist with one host per line, which the browser always handles itself.

Takeover is off by default and asks for confirmation the first time it is enabled. There is a concrete reason: to keep authenticated downloads working, the extension may read cookies for the target domain and send them with the task to Motrix. A built-in sensitive-host list excludes some banking, government, and medical sites. If Motrix cannot accept an ordinary HTTP(S) download, the extension tries to return it to the browser. Magnet links have no equivalent browser download to fall back to.

## Data and permissions

Your browser will say that this extension can access every website, downloads, and cookies. That is broad access. I do not want to hide it behind a vague “required for operation,” so here is what each part is for.

| Permission | Why it is used |
| --- | --- |
| Pages and network requests | Find links, media manifests, images, and other resources the page has loaded |
| Downloads | Take over a download and restore it to the browser if handoff fails |
| Cookies | Preserve an authenticated download when you submit a page resource or consent to takeover; remote Servers require another explicit grant |
| Native Messaging | Discover and connect to the Motrix App on this computer |
| Local storage | Keep settings, the Server list, pairing credentials, and per-Server permissions |
| Notifications and context menus | Report handoff results and add the **Download with Motrix** action |

Page-resource scanning happens locally in the browser. Opening a page does not send its full contents to Motrix. When you actually submit a task, the selected backend receives what it needs for the download: this can include the target URL, source page URL and title, and a suggested filename. Whether cookies and request headers are included depends on the download path, backend type, and the permissions you granted.

Remote Server permissions start at the narrowest scope. Unless you explicitly enable them, the extension does not send cookies or authentication headers to a remote Server. Grant those permissions only to a Server you control.

## Common questions

### Why can't the Chrome development build connect to Motrix?

Check that its extension ID appears under **Settings → Integration → Browser extensions → Trusted extensions** in Motrix. You can copy the ID from the Motrix Extension card on `chrome://extensions`. If you loaded the build from a different directory, Chrome may have assigned a new ID, so update the Motrix entry as well.

### Why can't the extension find Motrix on this computer?

Make sure Motrix is running, then scan again. If it is still missing, check whether the browser lets the extension reach local addresses and whether Motrix's browser integration component is installed. An older Motrix build may also be incompatible with the current pairing protocol.

### Why is a video on the page missing from the resource list?

Start playback for a few seconds and scan again. Detection uses page elements and requests that have actually happened, so the extension cannot see media that has not loaded yet. `blob:` URLs, DRM streams, short-lived links, and custom player packaging may also be unusable.

### Why is a paired remote Server refusing downloads?

Pairing answers “which Server is this?” It does not answer “what may I send it?” Open **Settings → Integration** and enable **Remote downloads** for that Server. If the resource also relies on a Referer, cookies, or authentication headers, grant only the additional permissions it needs.

### Can it download from YouTube?

Not yet.

## For developers

```bash
pnpm dev                 # Chromium development build
pnpm dev:firefox         # Firefox development build
pnpm test                # Test suite
pnpm lint                # Code checks
pnpm build:webstore      # Chrome Web Store-compliant build
```

The main areas of the codebase are:

- `src/background/` — pairing, connections, download handoff, task controls, and stored configuration;
- `src/popup/` — the extension popup;
- `src/options/` — the settings page;
- `src/content/` — page-resource detection;
- `src/adapters/` — site adapters.

## Related projects

- [Motrix](https://github.com/agalwood/Motrix) — desktop app and server
- [motrix-extension](https://github.com/motrixapp/motrix-extension) — public extension repository
- [MDXP](https://github.com/motrixapp/mdxp) — protocol schemas and connection helpers

## License

[MIT](./LICENSE) © 2026-present Dr_rOot
