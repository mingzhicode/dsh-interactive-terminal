import { defineConfig } from 'tsdown'

/** Build the public ESM entry points. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  fixedExtension: false,
  clean: true,
})
