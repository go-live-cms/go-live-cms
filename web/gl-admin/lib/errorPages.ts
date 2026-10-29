import { ApiError } from "@gl-admin/lib/api/errors"

// Which full-page error the admin shows for something a page threw or a request
// returned (#339): the 404 and 403 pages, or the generic one with an error ID.

export type ErrorPageInfo =
  | { kind: "not-found" }
  | { kind: "forbidden"; serverMessage: string | null }
  | {
      kind: "error"
      // The HTTP status, when the API answered at all ("Error 503"); null for a
      // crash in the page itself or an unreachable server.
      status: number | null
      // The API's request_id, shown as a copyable error ID.
      requestId: string | null
    }

// A lazily loaded page whose chunk failed to download (after a deploy, say) stays
// failed until the whole page reloads; the wording differs per browser.
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(error.message)
  )
}

export function errorPageFor(error: unknown): ErrorPageInfo {
  if (error instanceof ApiError) {
    if (error.status === 404) return { kind: "not-found" }
    if (error.status === 403) {
      // A bare "forbidden" comes from the role middleware: the page explains it.
      const reason = error.serverMessage && error.serverMessage.toLowerCase() !== "forbidden" ? error.message : null
      return { kind: "forbidden", serverMessage: reason }
    }
    return { kind: "error", status: error.status, requestId: error.requestId }
  }
  return { kind: "error", status: null, requestId: null }
}

// "Settings are open to admins only." for the router guard; the signed-in user is
// named after it. `area` is plural ("Settings", "Users", "Themes").
export function forbiddenReason(area: string | undefined, serverMessage: string | null): string {
  if (area) return `${area} ${/s$/i.test(area) ? "are" : "is"} open to admins only.`
  if (serverMessage) return serverMessage
  return "Your account doesn't have permission to open this."
}
