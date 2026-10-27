// Entry point of the bundled collab server (dist/collab-server/server.mjs, built by
// build.mjs). Reads the environment, checks the single-yjs-instance probe, and starts
// the Hocuspocus listener and the internal listener.
//
// Environment:
//   PORT                      WebSocket listener (default 1235)
//   HOST                      bind address (default 0.0.0.0)
//   INTERNAL_PORT             internal listener: /healthz, flush (default 1236; never publish it)
//   INTERNAL_API_URL          the API's internal listener, e.g. http://api:8081 (required)
//   ROLE_LOOKUP_SECRET        bearer secret for INTERNAL_API_URL (required; same as the API's)
//   COLLAB_INTERNAL_SECRET    bearer secret the API sends to flush (required; the API's
//                             COLLAB_INTERNAL_SECRET)
//   PASETO_V4_PUBLIC_KEY_HEX  the API's public key (raw Ed25519 hex), or
//   PASETO_V4_PUBLIC_PEM_FILE a PEM file with it
//   PASETO_ISSUER             default golive.auth (the API's default)
//   COLLAB_STORE_DEBOUNCE_MS / COLLAB_STORE_MAX_DEBOUNCE_MS  default 2000 / 10000
//   COLLAB_ACCESS_RECHECK_MS  re-check of open connections' access, per (user, doc),
//                             ±20% jitter (default 60000; 0 turns it off)
//   COLLAB_ACCESS_GRACE_MS    how long failed re-checks keep a connection writable
//                             before it is made read-only (default 120000)
import { readFileSync } from "node:fs"
import { createPublicKey, type KeyObject } from "node:crypto"
import { publicKeyFromHex, verifyTicket } from "./access"
import { createInternalApi } from "./api"
import { createInternalServer } from "./internal"
import { errorMessage, logEvent } from "./logsafe"
import { yjsInstanceIsShared } from "./probe"
import { createCollabServer } from "./server"

function fatal(message: string): never {
  logEvent("error", "collab_startup_failed", { error: message })
  process.exit(1)
}

const env = (name: string) => (process.env[name] ?? "").trim()
const intEnv = (name: string, fallback: number) => {
  const raw = env(name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) fatal(`${name} must be a non-negative integer`)
  return value
}

if (!yjsInstanceIsShared()) {
  fatal("yjs is loaded twice: Hocuspocus's Document is not an instance of this process's Y.Doc (see collab-server/CLAUDE.md)")
}

const apiUrl = env("INTERNAL_API_URL")
const roleLookupSecret = env("ROLE_LOOKUP_SECRET")
const internalSecret = env("COLLAB_INTERNAL_SECRET")
if (!apiUrl) fatal("INTERNAL_API_URL is required")
if (!roleLookupSecret) fatal("ROLE_LOOKUP_SECRET is required")
if (!internalSecret) fatal("COLLAB_INTERNAL_SECRET is required")

function loadPublicKey(): KeyObject {
  const hex = env("PASETO_V4_PUBLIC_KEY_HEX")
  const pemFile = env("PASETO_V4_PUBLIC_PEM_FILE")
  try {
    if (hex) return publicKeyFromHex(hex)
    if (pemFile) return createPublicKey(readFileSync(pemFile))
  } catch (error) {
    fatal(`could not load the PASETO public key: ${errorMessage(error)}`)
  }
  fatal("provide PASETO_V4_PUBLIC_KEY_HEX or PASETO_V4_PUBLIC_PEM_FILE")
}

const publicKey = loadPublicKey()
const issuer = env("PASETO_ISSUER") || "golive.auth"
const host = env("HOST") || "0.0.0.0"

const collab = createCollabServer({
  api: createInternalApi({ apiUrl, secret: roleLookupSecret }),
  verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer, docName }),
  port: intEnv("PORT", 1235),
  address: host,
  debounce: intEnv("COLLAB_STORE_DEBOUNCE_MS", 2000),
  maxDebounce: intEnv("COLLAB_STORE_MAX_DEBOUNCE_MS", 10_000),
  accessRecheck: {
    intervalMs: intEnv("COLLAB_ACCESS_RECHECK_MS", 60_000),
    graceMs: intEnv("COLLAB_ACCESS_GRACE_MS", 120_000),
  },
})

const internal = createInternalServer({ secret: internalSecret, flush: (docName) => collab.flush(docName) })

const port = await collab.listen()
const internalPort = intEnv("INTERNAL_PORT", 1236)
await new Promise<void>((resolve, reject) => {
  internal.once("error", reject)
  internal.listen(internalPort, host, () => resolve())
})
const internalAddress = internal.address()
logEvent("info", "collab_listening", {
  port,
  internal_port: typeof internalAddress === "object" && internalAddress ? internalAddress.port : internalPort,
  issuer,
  access_recheck_ms: intEnv("COLLAB_ACCESS_RECHECK_MS", 60_000),
  yjs_single_instance: true,
})

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logEvent("info", "collab_shutdown", { signal })
  internal.close()
  await collab.destroy()
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
