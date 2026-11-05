import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "../blocks-spec"
import { computeBlockDiff, DiffAbortedError, setDiffWorkerFactory, WORKER_IDLE_MS } from "./diffClient"
import { handleDiffRequest, type DiffRequest } from "./diffProtocol"

// diffClient (#355): one worker for the page, reused across comparisons and closed when
// idle; an abort drops the answer without killing the worker; a worker that fails falls
// back to the main thread.

const doc = (ids: string[]): BlockDocV1 => ({
  doc_version: 1,
  blocks_order: ids,
  blocks: Object.fromEntries(
    ids.map((id) => [id, { id, type: "paragraph", version: 1, attrs: { text: id } }])
  ) as BlockDocV1["blocks"],
})

/** A Worker stand-in that answers with the real handler on a later tick. */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = []
  terminated = false
  fail = false
  constructor() {
    super()
    FakeWorker.made.push(this)
  }
  postMessage(request: DiffRequest) {
    setTimeout(() => {
      if (this.terminated) return
      if (this.fail) {
        const event = new Event("error") as Event & { preventDefault(): void }
        this.dispatchEvent(event)
        return
      }
      this.dispatchEvent(new MessageEvent("message", { data: handleDiffRequest(request) }))
    }, 0)
  }
  terminate() {
    this.terminated = true
  }
}

beforeEach(() => {
  FakeWorker.made = []
  vi.stubGlobal("Worker", FakeWorker)
  setDiffWorkerFactory(() => new FakeWorker() as unknown as Worker)
})
afterEach(() => {
  setDiffWorkerFactory(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("computeBlockDiff", () => {
  it("reuses one worker across comparisons", async () => {
    const a = await computeBlockDiff(doc(["block-aaaa01"]), doc(["block-aaaa01", "block-bbbb02"]))
    const b = await computeBlockDiff(doc(["block-aaaa01"]), doc([]))
    expect(a.summary.workingOnly).toBe(1)
    expect(b.summary.versionOnly).toBe(1)
    expect(FakeWorker.made).toHaveLength(1)
    expect(FakeWorker.made[0].terminated).toBe(false)
  })

  it("closes the worker once it has been idle", async () => {
    vi.useFakeTimers()
    const done = computeBlockDiff(doc(["block-aaaa01"]), doc(["block-aaaa01"]))
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(FakeWorker.made[0].terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS)
    expect(FakeWorker.made[0].terminated).toBe(true)
  })

  it("rejects an aborted comparison but keeps the worker for the next one", async () => {
    const controller = new AbortController()
    const aborted = computeBlockDiff(doc(["block-aaaa01"]), doc([]), { signal: controller.signal })
    const other = computeBlockDiff(doc(["block-aaaa01"]), doc(["block-aaaa01"]))
    controller.abort()
    await expect(aborted).rejects.toBeInstanceOf(DiffAbortedError)
    expect((await other).summary.same).toBe(1)
    expect(FakeWorker.made).toHaveLength(1)
    expect(FakeWorker.made[0].terminated).toBe(false)
  })

  it("falls back to the main thread when the worker fails, and starts a new one next time", async () => {
    setDiffWorkerFactory(() => {
      const w = new FakeWorker()
      w.fail = FakeWorker.made.length === 1
      return w as unknown as Worker
    })
    const first = await computeBlockDiff(doc(["block-aaaa01"]), doc([]))
    expect(first.summary.versionOnly).toBe(1)
    expect(FakeWorker.made[0].terminated).toBe(true)
    await computeBlockDiff(doc(["block-aaaa01"]), doc([]))
    expect(FakeWorker.made).toHaveLength(2)
  })
})
