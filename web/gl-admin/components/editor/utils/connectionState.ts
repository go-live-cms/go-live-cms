import { useEffect, useState } from "react"
import type { CollabStatus } from "./useCollabPresence"

// What the editor tells the user about its connection (#341, "Editor connection states"):
//   - connecting:   opening the post, never connected yet;
//   - online:       connected, or dropped for less than RECONNECT_GRACE_MS (a blip shows
//                   nothing: no banner for the first few seconds);
//   - reconnecting: dropped for longer, the provider is retrying; edits wait in this tab;
//   - offline:      the browser says it's offline, or the drop outlasted OFFLINE_AFTER_MS;
//   - ended:        the server refused or revoked the session (the editor's "session
//                   ended" dialog says so); nothing will be sent, so no offline promise.
// Nothing is stored on the device (rule 0 in lib/collaboration/CLAUDE.md): while not
// connected, this tab holds the only copy of the edits made since. Publishing waits for
// a live connection (`status === "connected"`), grace period or not.

export type ConnectionView = "connecting" | "online" | "reconnecting" | "offline" | "ended"

export const RECONNECT_GRACE_MS = 3000
export const OFFLINE_AFTER_MS = 15000

export function connectionView({
  status,
  everConnected,
  droppedForMs,
  browserOnline,
}: {
  status: CollabStatus
  everConnected: boolean
  // How long the connection has been down (0 while connected).
  droppedForMs: number
  browserOnline: boolean
}): ConnectionView {
  if (status === "connected") return "online"
  if (status === "ended") return "ended"
  if (!everConnected) return "connecting"
  if (!browserOnline || droppedForMs >= OFFLINE_AFTER_MS) return "offline"
  if (droppedForMs >= RECONNECT_GRACE_MS) return "reconnecting"
  return "online"
}

// Warn before the tab closes while it holds edits the server doesn't have: unsynced
// changes, or a dropped connection (whatever is typed now waits in this tab).
export function shouldWarnBeforeUnload({
  editable,
  unsynced,
  offline,
}: {
  editable: boolean
  unsynced: boolean
  offline: boolean
}): boolean {
  return editable && (unsynced || offline)
}

// connectionView for a live status: re-renders when the grace and offline thresholds
// pass, and on the browser's online/offline events.
export function useConnectionView(status: CollabStatus, enabled: boolean): ConnectionView {
  const [everConnected, setEverConnected] = useState(false)
  const [droppedAt, setDroppedAt] = useState<number | null>(null)
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setEverConnected(false)
      setDroppedAt(null)
      return
    }
    if (status === "connected") {
      setEverConnected(true)
      setDroppedAt(null)
    } else {
      setDroppedAt((at) => at ?? Date.now())
    }
  }, [status, enabled])

  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine !== false)
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  // Re-render as each threshold passes.
  useEffect(() => {
    if (droppedAt === null || !everConnected) return
    const elapsed = Date.now() - droppedAt
    const timers = [RECONNECT_GRACE_MS, OFFLINE_AFTER_MS]
      .filter((t) => t > elapsed)
      .map((t) => setTimeout(() => setTick((n) => n + 1), t - elapsed))
    return () => timers.forEach(clearTimeout)
  }, [droppedAt, everConnected])

  if (!enabled) return "online"
  return connectionView({
    status,
    everConnected,
    droppedForMs: droppedAt === null ? 0 : Date.now() - droppedAt,
    browserOnline,
  })
}

// Asks the browser to confirm leaving while `warn` is true. Browsers show their own text.
export function useBeforeUnloadWarning(warn: boolean): void {
  useEffect(() => {
    if (!warn) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Older browsers need returnValue set.
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [warn])
}
