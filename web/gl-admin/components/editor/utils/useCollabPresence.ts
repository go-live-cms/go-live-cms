import { useEffect, useState } from "react"
import type { HocuspocusCollaboration } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { acquirePostCollab, releasePostCollab } from "@gl-admin/lib/collaboration/postCollab"

export type CollabStatus = "connecting" | "connected" | "disconnected"
export type CollabUser = { clientId: number; id?: number; name?: string; color?: string }

// The same connection the editor uses (shared, ref-counted), re-acquired when it goes
// stale (the server reseeded the doc and the editor remounted).
export function useCollabPresence(postId?: number, enabled = true) {
  const [collab, setCollab] = useState<HocuspocusCollaboration | null>(null)
  const [generation, setGeneration] = useState(0)
  const [status, setStatus] = useState<CollabStatus>("disconnected")
  const [users, setUsers] = useState<CollabUser[]>([])
  // Local edits the server hasn't acknowledged yet (the provider's own count): this tab
  // holds the only copy of them (#341, the unload warning).
  const [unsynced, setUnsynced] = useState(false)

  useEffect(() => {
    if (!postId || !enabled) {
      setCollab(null)
      setStatus("disconnected")
      setUsers([])
      setUnsynced(false)
      return
    }
    const instance = acquirePostCollab(postId)
    setCollab(instance)
    const awareness = instance.provider.awareness
    const onUnsynced = () => setUnsynced(instance.provider.hasUnsyncedChanges)
    let raf = 0
    const onStatus = (s = instance.getStatus()) =>
      setStatus(s === "connected" ? "connected" : s === "connecting" ? "connecting" : "disconnected")
    const onUsers = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const states = awareness?.getStates()
        if (!states) return setUsers([])
        setUsers(
          Array.from(states.entries())
            .map(([clientId, s]) => ({ clientId, ...((s as { user?: object })?.user ?? {}) }))
            .filter((u) => u.clientId !== awareness?.clientID)
        )
      })
    }
    onStatus()
    onUsers()
    onUnsynced()
    const offStatus = instance.onStatus(onStatus)
    const offStale = instance.onStale(() => setGeneration((g) => g + 1))
    awareness?.on("change", onUsers)
    instance.provider.on("unsyncedChanges", onUnsynced)
    return () => {
      cancelAnimationFrame(raf)
      offStatus()
      offStale()
      awareness?.off("change", onUsers)
      instance.provider.off("unsyncedChanges", onUnsynced)
      releasePostCollab(instance)
    }
  }, [postId, enabled, generation])

  const clientId = collab?.provider.awareness?.clientID
  return { status, unsynced, users: clientId != null ? users.filter((u) => u.clientId !== clientId) : users }
}
