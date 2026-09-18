import { vi } from 'vitest'

// jsdom has no canvas renderer or layout; xterm's real ANSI parser remains active.
if (typeof window !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
