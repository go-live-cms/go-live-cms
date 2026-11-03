// The request each log line belongs to (#378). The middleware runs every request inside
// runWithLogContext, so anything logged while it is handled (pages, layouts, src/lib,
// the API proxy), however deep, carries its request id and route without being passed
// them. Kept out of src/lib/log.ts because that module is also bundled for the browser.

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { setLogContextSource, type LogContext } from "../lib/log"

const storage = new AsyncLocalStorage<LogContext>()
setLogContextSource(() => storage.getStore())

// The API's rule for a well-formed id (api/observability.go). Caddy replaces whatever
// the client sent with a fresh UUID, so in production the header is always Caddy's.
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/

// The id from X-Request-ID, or a new UUID when there is none (dev, no Caddy) or it is
// malformed, so a request's lines can still be grouped.
export function requestIdFrom(headers: Headers): string {
  const id = headers.get("x-request-id")?.trim()
  return id && REQUEST_ID.test(id) ? id : randomUUID()
}

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn)
}
