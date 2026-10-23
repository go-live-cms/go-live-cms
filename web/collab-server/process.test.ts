// Spawned-process tests of the real bundle (#206): what in-process vitest can't show.
// vitest resolves a single yjs for everything it imports, so the dual ESM/CJS instance
// hazard (collab-server/CLAUDE.md) only shows up in a real `node` process running the
// file production runs. The bundle is built into a temp dir with no node_modules next
// to it, exactly like the image.
//
// CI runs this on Node 22 (web-tests) and on the image's Node 24 (the docker smoke step).
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Server } from "node:http"
import { DENY } from "./auth"
import { appendParagraph, connect, FakeCollabApi, paragraphDoc, paragraphs, serveFakeApi, ticketKeys, waitFor, type Client } from "./testkit"
import { canonical } from "../gl-admin/lib/collaboration/fragmentBridge.fixtures"

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, "..")
const YJS_WARNING = "Yjs was already imported"
const ROLE_SECRET = "role-secret-for-tests"
const FLUSH_SECRET = "flush-secret-for-tests"

const { publicKeyHex, sign } = await ticketKeys()
let dir: string
let bundle: string
let api: FakeCollabApi
let apiServer: Server
let child: ChildProcess
let stdout = ""
let stderr = ""
let wsUrl = ""
let internalUrl = ""
const clients: Client[] = []

/** Starts the bundle; resolves with its collab_listening line. */
async function startBundle(env: Record<string, string>): Promise<{ port: number; internal_port: number }> {
  child = spawn(process.execPath, [bundle], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", INTERNAL_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout!.on("data", (chunk) => (stdout += chunk))
  child.stderr!.on("data", (chunk) => (stderr += chunk))
  await waitFor(() => stdout.includes('"collab_listening"') || child.exitCode !== null, { timeoutMs: 20_000, what: "the bundle to listen" })
  const line = stdout.split("\n").find((l) => l.includes('"collab_listening"'))
  if (!line) throw new Error(`bundle exited ${child.exitCode}: ${stderr}${stdout}`)
  return JSON.parse(line)
}

const ticket = (userId: string, doc = "post-12") => sign({ user_id: userId, doc, iat: new Date().toISOString() })

function open(userId: string, opts: { doc?: string; token?: () => Promise<string> | string } = {}) {
  const client = connect(wsUrl, opts.doc ?? "post-12", opts.token ?? (() => ticket(userId, opts.doc)))
  clients.push(client)
  return client
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gl-collab-"))
  bundle = path.join(dir, "server.mjs")
  await run(process.execPath, [path.join(here, "build.mjs"), bundle], { cwd: webRoot })

  api = new FakeCollabApi()
  api.users.set("2", { role: "editor" })
  api.users.set("3", { role: "contributor" })
  api.addPost("12", canonical(paragraphDoc("one", "two")), 5)
  const served = await serveFakeApi(api, ROLE_SECRET)
  apiServer = served.server

  const listening = await startBundle({
    INTERNAL_API_URL: served.url,
    ROLE_LOOKUP_SECRET: ROLE_SECRET,
    COLLAB_INTERNAL_SECRET: FLUSH_SECRET,
    PASETO_V4_PUBLIC_KEY_HEX: publicKeyHex,
    COLLAB_STORE_DEBOUNCE_MS: "60000",
  })
  wsUrl = `ws://127.0.0.1:${listening.port}`
  internalUrl = `http://127.0.0.1:${listening.internal_port}`
}, 120_000)

afterAll(async () => {
  clients.forEach((client) => client.destroy())
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await waitFor(() => child.exitCode !== null, { timeoutMs: 15_000, what: "the bundle to exit" }).catch(() => child.kill("SIGKILL"))
  }
  apiServer?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the bundled server process", () => {
  it("starts with one yjs instance: probe passed, no double-load warning", () => {
    expect(stdout).toContain('"yjs_single_instance":true')
    expect(stderr + stdout).not.toContain(YJS_WARNING)
  })

  it("the warning check would catch a double load (it's what yjs prints)", async () => {
    // ESM + CJS yjs in one process, the 2026-06 failure, from web/'s node_modules.
    const script = path.join(dir, "double.mjs")
    writeFileSync(
      script,
      `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path.join(webRoot, "package.json"))});
       require("yjs"); await import(${JSON.stringify(pathToFileURL(path.join(webRoot, "node_modules/yjs/dist/yjs.mjs")).href)});`,
    )
    const { stdout: out, stderr: err } = await run(process.execPath, [script])
    expect(out + err).toContain(YJS_WARNING)
  })

  it("an editor connects read-write and the session survives edits", async () => {
    const editor = open("2")
    const outcome = await editor.outcome
    expect(outcome).toEqual({ synced: true, readOnly: false })
    expect(paragraphs(editor.doc)).toEqual(["one", "two"])
  })

  it("a contributor on someone else's post connects read-only", async () => {
    expect(await open("3").outcome).toEqual({ synced: true, readOnly: true })
  })

  it("refuses a bad ticket, an other-doc ticket and a used ticket", async () => {
    expect(await open("2", { token: () => "v4.public.not-a-ticket" }).outcome).toEqual({ synced: false, reason: DENY.forbidden })
    expect(await open("2", { token: () => ticket("2", "post-13") }).outcome).toEqual({ synced: false, reason: DENY.forbidden })
    const used = await ticket("2")
    expect((await open("2", { token: () => used }).outcome).synced).toBe(true)
    expect(await open("2", { token: () => used }).outcome).toEqual({ synced: false, reason: DENY.forbidden })
  })

  it("refuses when the API is down", async () => {
    api.failAccess = true
    try {
      expect(await open("2").outcome).toEqual({ synced: false, reason: DENY.unavailable })
    } finally {
      api.failAccess = false
    }
  })

  it("flush requires the secret, and stores the live doc through the API", async () => {
    const editor = open("2")
    await editor.outcome
    appendParagraph(editor.doc, "flush me", "blk-flush-me-001")
    await new Promise((resolve) => setTimeout(resolve, 300))

    const flush = (auth?: string) =>
      fetch(`${internalUrl}/internal/documents/post-12/flush`, { method: "POST", headers: auth ? { Authorization: auth } : {} })
    expect((await flush()).status).toBe(401)
    expect((await flush("Bearer nope")).status).toBe(401)
    const res = await flush(`Bearer ${FLUSH_SECRET}`)
    expect(res.status).toBe(200)
    expect(api.posts.get("12")!.block_doc!.blocks_order).toContain("blk-flush-me-001")
    expect((await fetch(`${internalUrl}/healthz`)).status).toBe(200)
  })

  it("never logs a ticket or the shared secrets", async () => {
    const t = await ticket("3")
    await open("3", { token: () => t }).outcome
    await open("3", { token: () => t }).outcome
    const logs = stdout + stderr
    expect(logs).toContain('"ws_deny"')
    expect(logs).toContain('"ws_connect"')
    expect(logs).not.toContain(t.slice("v4.public.".length, "v4.public.".length + 40))
    expect(logs).not.toContain(ROLE_SECRET)
    expect(logs).not.toContain(FLUSH_SECRET)
  })

  it("still printed no yjs warning after all that", () => {
    expect(stderr + stdout).not.toContain(YJS_WARNING)
  })
})
