import { vi } from 'vitest'

/** Advance operation deadlines and drain promise reactions. */
export async function advanceClock(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds)
}

/** A manually completed asynchronous transport action. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}
