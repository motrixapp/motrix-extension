import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const ADAPTER_REGISTRY_ID = 'virtual:motrix-adapter-registry'
const YOUTUBE_SNIFFER_SCRIPT_ID = 'virtual:motrix-youtube-sniffer-script'

export function buildVariantPlugin(webStore: boolean): Plugin {
  const resolvedAdapterRegistryId = `\0${ADAPTER_REGISTRY_ID}`
  const resolvedYoutubeSnifferScriptId = `\0${YOUTUBE_SNIFFER_SCRIPT_ID}`
  return {
    name: 'motrix-build-variant',
    enforce: 'pre',
    resolveId(id) {
      if (id === ADAPTER_REGISTRY_ID) return resolvedAdapterRegistryId
      if (id === YOUTUBE_SNIFFER_SCRIPT_ID) {
        return resolvedYoutubeSnifferScriptId
      }
      return null
    },
    load(id) {
      if (id === resolvedAdapterRegistryId) {
        if (webStore) return 'export const adapterRegistry = []'
        const adapterPath = resolve(
          import.meta.dirname,
          'src/adapters/youtube/index'
        )
        return `import { youtubeAdapter } from ${JSON.stringify(adapterPath)}; export const adapterRegistry = [youtubeAdapter]`
      }
      if (id === resolvedYoutubeSnifferScriptId) {
        if (webStore) return 'export default null'
        const entryPath = `${resolve(
          import.meta.dirname,
          'src/content/youtube-sniffer-entry'
        )}?script&iife`
        return `import scriptPath from ${JSON.stringify(entryPath)}; export default scriptPath`
      }
      return null
    },
  }
}

async function removeFinderMetadata(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await removeFinderMetadata(path)
      } else if (entry.name === '.DS_Store') {
        await unlink(path)
      }
    })
  )
}

/** Keep OS metadata from leaking into packaged extension artifacts. */
export function buildOutputHygienePlugin(outputDir: string): Plugin {
  return {
    name: 'motrix-build-output-hygiene',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      await removeFinderMetadata(outputDir)
    },
  }
}
