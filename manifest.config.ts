import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest((env) => {
  const firefox = env.mode === 'firefox'
  const webStore =
    env.mode === 'webstore' || process.env.MOTRIX_BUILD === 'webstore'
  const includeYouTube = !webStore && !firefox
  const genericSnifferScripts = [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/sniffer-relay.ts'],
      run_at: 'document_start' as const,
      all_frames: true,
      world: 'ISOLATED' as const,
    },
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/sniffer-entry.ts'],
      run_at: 'document_start' as const,
      all_frames: true,
      world: 'MAIN' as const,
    },
  ]
  return {
    manifest_version: 3,
    name: 'Motrix Extension',
    version: pkg.version,
    description: 'Send downloads to Motrix',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      96: 'icons/icon-96.png',
      128: 'icons/icon-128.png',
    },
    permissions: [
      'nativeMessaging',
      'storage',
      'activeTab',
      'scripting',
      'alarms',
      'notifications',
      'contextMenus',
      'downloads',
      'cookies',
      'webRequest',
      'webNavigation',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_popup: 'popup.html',
      default_title: 'Motrix',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [
      ...genericSnifferScripts,
      ...(includeYouTube
        ? [
            {
              matches: ['*://*.youtube.com/*', '*://youtu.be/*'],
              js: ['src/content/index.ts'],
              run_at: 'document_idle' as const,
            },
          ]
        : []),
    ],
    // Generic discovery is backend-independent and starts in every frame.
    // Both browsers use a MAIN-world collector plus an ISOLATED runtime relay
    // so page fetch/XHR are observable. Firefox requires 128+ for MAIN-world
    // manifest content scripts; the relay keeps an isolated fallback if the
    // MAIN-world hello never arrives. Dynamic injection remains available for
    // explicit SPA rescans.
    //
    // IMPORTANT: the SW entry is `service-worker.ts`, NOT `index.ts`. The content script is
    // `src/content/index.ts`; if the SW entry were also named `index.ts`, both emit
    // `index.ts-<hash>.js` and crxjs's service-worker-loader resolves to the WRONG chunk
    // (the content bundle), so the SW never registers its onMessage listener and every
    // popup request fails with "Could not establish connection. Receiving end does not exist."
    // Keep this basename unique. (See debugging notes 2026-06-29.)
    background: firefox
      ? { scripts: ['src/background/service-worker.ts'], type: 'module' }
      : { service_worker: 'src/background/service-worker.ts', type: 'module' },
    ...(firefox
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'motrix-extension@motrix.app',
              // Firefox 140 introduced the built-in data-transmission consent
              // experience on desktop, while Firefox for Android gained the
              // same manifest support in 142. Use the shared floor so AMO does
              // not advertise an unsupported Android compatibility range. It
              // also includes the execution-world support used by the generic
              // fetch/XHR collector (introduced in Firefox 128).
              strict_min_version: '142.0',
              data_collection_permissions: {
                required: [
                  'authenticationInfo',
                  'browsingActivity',
                  'websiteContent',
                  'websiteActivity',
                ],
              },
            },
            // Firefox for Android has no Native Messaging, but remote Motrix
            // Server pairing uses the network transport and remains useful.
            // Android 142 is the first release with the built-in data consent
            // manifest support declared above.
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : { minimum_chrome_version: '120' }),
  }
})
