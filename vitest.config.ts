import { defineConfig } from 'vitest/config'

/** Run the package unit tests in Node.js. */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    setupFiles: ['tests/client/setup.ts'],
  },
})
