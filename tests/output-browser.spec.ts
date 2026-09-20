import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchBrowser } from './web-browser.ts'

it('renders a burst through the real client hook without per-chunk browser timer waits', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { Terminal } from '@xterm/xterm';
        import { useTerminal } from './src/client/use-terminal.ts';
        let terminal, handlers;
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function(element) { terminal = this; open.call(this, element); };
        const transport = { attach(_session, _options, callbacks) { handlers = callbacks; return {send() {}, dispose() {}}; }, track() { return () => {}; } };
        const onDisposed = () => {};
        function View() {
          const { container } = useTerminal('benchmark', transport, false, true, onDisposed);
          return <div ref={container} />;
        }
        const root = createRoot(document.getElementById('app'));
        window.runOutputBurst = async () => {
          flushSync(() => root.render(null));
          flushSync(() => root.render(<View />));
          handlers.frame({ type:'terminal.snapshot', version:1, generation:1, scrollbackLines:2000,
            snapshot:{ sequence:0, rows:40, cols:160, replay:'', historyBytes:0, truncated:false } });
          await new Promise(resolve => terminal.write('', resolve));
          const started = performance.now();
          for(let sequence=1; sequence<=1000; sequence++) {
            handlers.frame({ type:'terminal.output', version:1, generation:1, sequence, output:'abcdefghij' });
          }
          // This marker can overtake queued application promises, but not native FIFO writes.
          await new Promise(resolve => terminal.write('END', resolve));
          const parsedMs = performance.now()-started;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const buffer = terminal.buffer.active;
          const text = Array.from({length:buffer.length}, (_,i) => buffer.getLine(i).translateToString(true)).join('');
          return { parsedMs, visibleMs: performance.now()-started, text, rows:document.querySelector('.xterm-rows').textContent };
        };
        window.disposeOutputBench = () => root.unmount();
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const measurements: Array<{ run: number; frames: number; bytes: number; parsedMs: number; visibleMs: number }> = []
    for (let run = 0; run < 3; run++) {
      const result = await page.evaluate<{ parsedMs: number; visibleMs: number; text: string; rows: string }>('window.runOutputBurst()')
      expect(result.text).toBe('abcdefghij'.repeat(1000) + 'END')
      expect(result.rows).toContain('END')
      expect(result.parsedMs).toBeLessThan(1000)
      measurements.push({ run, frames: 1000, bytes: 10000, parsedMs: Math.round(result.parsedMs), visibleMs: Math.round(result.visibleMs) })
    }
    await mkdir('artifacts', { recursive: true })
    await writeFile('artifacts/terminal-output-benchmark.json', JSON.stringify({ environment: 'isolated Chromium with the production React hook; no PTY or WebSocket latency', visibleMs: 'DOM checked after two animation frames; not a physical display measurement', measurements }, null, 2) + '\n')
    await page.evaluate('window.disposeOutputBench()')
  } finally { await browser.close() }
}, 20000)
