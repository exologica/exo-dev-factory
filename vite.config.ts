import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787'
    }
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true
  },
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.mjs',
      '.autonomy/**/*.test.ts',
      '.autonomy/**/*.test.mjs'
    ]
  }
})
