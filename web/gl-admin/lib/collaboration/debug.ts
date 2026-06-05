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
    console.debug(`[collab t=${Date.now()}]`, ...args)
  }
}

/** Short, cheap fingerprint of a string so we can spot content reverting/shrinking. */
export function contentFingerprint(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `len=${text.length} h=${(hash >>> 0).toString(16)}`
}
