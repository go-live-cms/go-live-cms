/**
 * Debug-gated logging for the collaboration layer.
 *
 * Off by default. Turn on in the browser console with:
 *   localStorage.setItem("GL_DEBUG_COLLAB", "1")   // then reload
 * Turn off with:
 *   localStorage.removeItem("GL_DEBUG_COLLAB")
 *
 * Used to capture the disconnect → reconnect → resync sequence when diagnosing
 * the WS-restart instability. Every line is timestamped so client logs can be
 * aligned against the WS server's COLLAB_DEBUG logs on the same timeline.
 *
 * NOTE: uses `console.log`, NOT `console.debug` — Chrome's console hides debug-level
 * messages unless "Verbose" is enabled in the level filter, which made these logs appear
 * to be missing entirely even with the flag set. Keep it as `console.log`.
 */
export function collabDebugEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem("GL_DEBUG_COLLAB") === "1"
  } catch {
    return false
  }
}

export function collabDebug(...args: unknown[]): void {
  if (collabDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(`[collab t=${Date.now()}]`, ...args)
  }
}

/**
 * Short, cheap fingerprint so we can spot content reverting/shrinking in the logs.
 * Y.XmlFragment#toJSON() returns a string; we coerce defensively for any other
 * input. JSON.stringify can throw (circular refs, BigInt), so it's wrapped — debug
 * instrumentation must never be able to crash the app when GL_DEBUG_COLLAB is on.
 */
export function contentFingerprint(value: unknown): string {
  let text: string
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `len=${text.length} h=${(hash >>> 0).toString(16)}`
}
