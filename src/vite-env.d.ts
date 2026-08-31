/// <reference types="vite/client" />

declare const __MOTRIX_BUILD__: 'webstore' | 'full' | undefined

declare module 'virtual:motrix-adapter-registry' {
  import type { SiteAdapter } from '@/adapters/SiteAdapter'

  export const adapterRegistry: SiteAdapter[]
}

declare module 'virtual:motrix-youtube-sniffer-script' {
  const scriptPath: string | null
  export default scriptPath
}
