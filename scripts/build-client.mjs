/** Produce the public DSH classic-script factory, including plugin-owned CSS. */
import { copyFile, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { build } from 'esbuild'

const id = 'dsh-interactive-terminal'
// These are the only runtime platform imports in this client; type imports erase.
const external = ['react', 'react/jsx-runtime']
await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  plugins: [{
    name: 'dsh-public-browser-imports',
    setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\// }, args => { throw new Error(`Unexpected browser runtime import ${args.path}; use injected services`) })
      builder.onLoad({ filter: /\.css$/ }, async args => ({
        loader: 'js',
        contents: `const key = ${JSON.stringify(`${id}/${basename(args.path)}`)};
          if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(key) + ']')) {
            const tag = document.createElement('style');
            tag.dataset.plugin = ${JSON.stringify(id)};
            tag.dataset.pluginCss = key;
            tag.textContent = ${JSON.stringify(await readFile(args.path, 'utf8'))};
            document.head.appendChild(tag);
          }`,
      }))
    },
  }],
})
await copyFile('src/client/css.d.ts', 'lib/client/css.d.ts')
