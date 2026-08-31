import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { buildVariantPlugin } from '#build-variant-plugin'

export default defineConfig({
  plugins: [buildVariantPlugin(false)],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
