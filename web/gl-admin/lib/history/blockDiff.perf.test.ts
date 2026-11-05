// @vitest-environment node
import path from "node:path"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"
import type { Block, BlockDocV1 } from "../blocks-spec"
import { diffBlockDocs } from "./blockDiff"
import { diffBlockDocsAsync } from "./diffClient"
import type { DiffResponse } from "./diffProtocol"

// A 2,000-block post stays responsive (#355): the diff runs in a worker, and the worker
// entry really bundles on its own (no DOM, React or editor code in its graph). The real
// blockDiff.worker.ts is bundled with esbuild and run in a Node worker thread, with `self`
// mapped onto worker_threads, while the main thread's timer keeps ticking.

const BLOCKS = 2000
// Generous for CI (the diff takes well under a second on a laptop).
const BUDGET_MS = 3000

const words = "the quick brown fox jumps over a lazy dog while editors type in real time across many tabs".split(" ")
function sentence(seed: number, n = 40): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(words[(seed * 7 + i * 13) % words.length])
  return out.join(" ")
}

const id = (n: number) => `block-${String(n).padStart(6, "0")}`

function paragraph(n: number, text: string): Block {
  return {
    id: id(n),
    type: "paragraph",
    version: 1,
    attrs: { pm: { type: "paragraph", content: [{ type: "text", text }] }, text },
  }
}

/** A 2,000-block version, and a working copy with edits, inserts, deletes and moves. */
function bigDocs(): { version: BlockDocV1; working: BlockDocV1 } {
  const vBlocks: Record<string, Block> = {}
  const wBlocks: Record<string, Block> = {}
  const vOrder: string[] = []
  const wOrder: string[] = []
  for (let n = 0; n < BLOCKS; n++) {
    const text = sentence(n)
    const block = paragraph(n, text)
    vBlocks[block.id] = block
    vOrder.push(block.id)
    if (n % 50 === 7) continue // deleted in the working copy
    const edited = n % 10 === 3 ? paragraph(n, `${text.slice(0, 60)} rewritten words here ${text.slice(90)}`) : block
    wBlocks[edited.id] = edited
    wOrder.push(edited.id)
    if (n % 50 === 11) {
      const added = paragraph(100_000 + n, sentence(n + 1))
      wBlocks[added.id] = added
      wOrder.push(added.id)
    }
  }
  // Move a few blocks far away.
  for (const n of [5, 400, 1200]) {
    const i = wOrder.indexOf(id(n))
    wOrder.splice(i, 1)
    wOrder.splice(Math.min(wOrder.length, i + 300), 0, id(n))
  }
  return {
    version: { doc_version: 1, blocks_order: vOrder, blocks: vBlocks },
    working: { doc_version: 1, blocks_order: wOrder, blocks: wBlocks },
  }
}

async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [path.resolve("gl-admin/lib/history/blockDiff.worker.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    // The browser worker's `self`, on top of worker_threads.
    banner: {
      js: `const { parentPort } = require("node:worker_threads"); globalThis.self = { postMessage: (m) => parentPort.postMessage(m), set onmessage(fn) { parentPort.on("message", (data) => fn({ data })) } };`,
    },
    logLevel: "silent",
  })
  return result.outputFiles[0].text
}

describe("block diff on a 2,000-block post", () => {
  const { version, working } = bigDocs()

  it("finds the edits, inserts, deletes and moves within the budget", () => {
    const start = performance.now()
    const diff = diffBlockDocs(version, working)
    const ms = performance.now() - start
    expect(diff.summary.changed).toBe(200)
    expect(diff.summary.versionOnly).toBe(40)
    expect(diff.summary.workingOnly).toBe(40)
    expect(diff.summary.moved).toBe(3)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("runs off the main thread in the bundled worker, while the main thread keeps ticking", async () => {
    const code = await bundleWorker()
    // Only the diff modules are in the worker's graph.
    expect(code).not.toMatch(/from "react"|require\("react"\)|@tiptap|yjs/)

    const worker = new Worker(code, { eval: true })
    let ticks = 0
    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      ticks++
    }, 5)
    try {
      const start = performance.now()
      const response = await new Promise<DiffResponse>((resolve, reject) => {
        worker.once("message", resolve)
        worker.once("error", reject)
        worker.postMessage({ id: 1, version, working })
      })
      const ms = performance.now() - start
      expect("diff" in response).toBe(true)
      if (!("diff" in response)) return
      expect(response.diff.summary).toEqual(diffBlockDocs(version, working).summary)
      expect(ms).toBeLessThan(BUDGET_MS)
      // The main thread was free: its 5 ms timer ran, never held up for long.
      expect(ticks).toBeGreaterThan(0)
      expect(maxGap).toBeLessThan(250)
    } finally {
      clearInterval(timer)
      await worker.terminate()
    }
  }, 30_000)

  it("on the main-thread fallback, yields in short slices", async () => {
    let yields = 0
    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    try {
      const diff = await diffBlockDocsAsync(version, working, { sliceMs: 8, onYield: () => yields++ })
      expect(diff.summary).toEqual(diffBlockDocs(version, working).summary)
    } finally {
      clearInterval(timer)
    }
    // It gave the event loop back many times, never holding it for long.
    expect(yields).toBeGreaterThan(1)
    expect(maxGap).toBeLessThan(250)
  })
})
