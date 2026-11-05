// Runs History's block diff (#355) without blocking the page: in a Web Worker
// (blockDiff.worker.ts) when the browser can start one, else on the main thread in
// slices that yield to the event loop between them. Either way the comparison only reads
// the two Block Spec docs it is given (never the editor or the Yjs document).

import type { BlockDocV1 } from "../blocks-spec"
import { diffBlockDocsSteps, type BlockDocDiff } from "./blockDiff"
import type { DiffRequest, DiffResponse } from "./diffProtocol"

/** Longest a main-thread slice runs before yielding (ms), below a 60 Hz frame. */
export const SLICE_MS = 8

export class DiffAbortedError extends Error {
  constructor() {
    super("The comparison was cancelled")
    this.name = "DiffAbortedError"
  }
}

type WorkerFactory = () => Worker

// Vite turns this into a bundled worker file (dev and build); kept in a function so the
// URL is only resolved where Worker exists.
const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("./blockDiff.worker.ts", import.meta.url), { type: "module", name: "history-diff" })

/** A worker with nothing to do is closed after this long (ms). */
export const WORKER_IDLE_MS = 60_000

let workerFactory: WorkerFactory | null = defaultWorkerFactory
let nextId = 1

// One worker for the page, kept while comparisons come (the preview re-runs one on every
// store while a version is shown), closed when idle.
let shared: Worker | null = null
let pending = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined

function closeShared(): void {
  clearTimeout(idleTimer)
  shared?.terminate()
  shared = null
  pending = 0
}

function sharedWorker(): Worker | null {
  if (shared) return shared
  if (!workerFactory || typeof Worker === "undefined") return null
  try {
    shared = workerFactory()
  } catch {
    return null // blocked (CSP) or unsupported: fall back
  }
  return shared
}

/** Tests: replace how the worker is made (null: no worker, use the main-thread fallback). */
export function setDiffWorkerFactory(factory: WorkerFactory | null | undefined): void {
  closeShared()
  workerFactory = factory === undefined ? defaultWorkerFactory : factory
}

function abortError(): DiffAbortedError {
  return new DiffAbortedError()
}

/**
 * The diff of `version` against `working`. Rejects with DiffAbortedError when `signal`
 * aborts (the user picked another version or turned the switch off); the worker then
 * finishes that diff and its answer is dropped.
 */
export function computeBlockDiff(
  version: BlockDocV1 | null,
  working: BlockDocV1 | null,
  { signal }: { signal?: AbortSignal } = {}
): Promise<BlockDocDiff> {
  if (signal?.aborted) return Promise.reject(abortError())
  const w = sharedWorker()
  if (!w) return diffBlockDocsAsync(version, working, { signal })

  clearTimeout(idleTimer)
  pending++
  return new Promise<BlockDocDiff>((resolve, reject) => {
    const id = nextId++
    let settled = false
    const finish = () => {
      settled = true
      signal?.removeEventListener("abort", onAbort)
      w.removeEventListener("message", onMessage)
      w.removeEventListener("error", onError)
      if (shared === w && --pending <= 0) {
        pending = 0
        idleTimer = setTimeout(closeShared, WORKER_IDLE_MS)
      }
    }
    const onAbort = () => {
      if (settled) return
      finish()
      reject(abortError())
    }
    const onMessage = (event: MessageEvent<DiffResponse>) => {
      if (settled || event.data?.id !== id) return
      finish()
      if ("diff" in event.data) resolve(event.data.diff)
      else reject(new Error(event.data.error))
    }
    // The worker couldn't load or crashed: drop it and do this one here instead.
    const onError = (event: ErrorEvent) => {
      event.preventDefault?.()
      if (settled) return
      finish()
      if (shared === w) closeShared()
      diffBlockDocsAsync(version, working, { signal }).then(resolve, reject)
    }
    signal?.addEventListener("abort", onAbort)
    w.addEventListener("message", onMessage)
    w.addEventListener("error", onError)
    const request: DiffRequest = { id, version, working }
    w.postMessage(request)
  })
}

/** Yields to the event loop (a macrotask, so input and paint get their turn). */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The main-thread fallback: the same diff, a block at a time, yielding whenever a slice
 * has run for `sliceMs`.
 */
export async function diffBlockDocsAsync(
  version: BlockDocV1 | null,
  working: BlockDocV1 | null,
  { signal, sliceMs = SLICE_MS, onYield }: { signal?: AbortSignal; sliceMs?: number; onYield?: () => void } = {}
): Promise<BlockDocDiff> {
  const steps = diffBlockDocsSteps(version, working)
  let sliceStart = Date.now()
  for (;;) {
    if (signal?.aborted) throw abortError()
    const next = steps.next()
    if (next.done) return next.value
    if (Date.now() - sliceStart >= sliceMs) {
      onYield?.()
      await yieldToMain()
      sliceStart = Date.now()
    }
  }
}
