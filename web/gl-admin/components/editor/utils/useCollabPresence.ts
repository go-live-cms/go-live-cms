import { useEffect, useMemo, useState } from "react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import { usesHocuspocus } from "@gl-admin/lib/collaboration/backend"
import type { HocuspocusCollaboration } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { acquirePostCollab, releasePostCollab } from "@gl-admin/lib/collaboration/postCollab"

export type CollabStatus = "connecting" | "connected" | "disconnected"
export type CollabUser = { clientId: number; id?: number; name?: string; color?: string }

function useYWebsocketPresence(postId?: number, enabled = true) {
  const provider = useMemo(() => {
    if (!postId || !enabled) return null
    return CollaborationProvider.getInstance(postId)
  }, [postId, enabled])

  const [status, setStatus] = useState<CollabStatus>("disconnected")
  const [users, setUsers] = useState<CollabUser[]>([])

  useEffect(() => {
    if (!provider) {
      setStatus("disconnected")
      setUsers([])
      return
    }

    // map y-websocket events to our status
    const mapStatus = (evt?: any): CollabStatus => {
      const raw = evt?.status ?? provider.getConnectionStatus()
      return raw === "connected" || raw === true ? "connected" : raw === "disconnected" ? "disconnected" : "connecting"
    }

    let raf = 0
    const onStatus = (evt?: any) => setStatus(mapStatus(evt))
    const onUsers = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setUsers(provider.getConnectedUsers()))
    }

    // initial
    onStatus()
    onUsers()

    provider.provider.on("status", onStatus)
    provider.provider.awareness.on("change", onUsers)

    return () => {
      cancelAnimationFrame(raf)
      provider.provider.off("status", onStatus)
      provider.provider.awareness.off("change", onUsers)
      // do not release here; Editor owns lifecycle
    }
  }, [provider])

  const clientId = provider?.provider.awareness.clientID
  const others = clientId != null ? users.filter((u) => u.clientId !== clientId) : users

  return { status, users: others }
}

// Hocuspocus path (#206 P3): the same connection the editor uses (shared, ref-counted),
// re-acquired when it goes stale (the server reseeded the doc and the editor remounted).
function useHocuspocusPresence(postId?: number, enabled = true) {
  const [collab, setCollab] = useState<HocuspocusCollaboration | null>(null)
  const [generation, setGeneration] = useState(0)
  const [status, setStatus] = useState<CollabStatus>("disconnected")
  const [users, setUsers] = useState<CollabUser[]>([])

  useEffect(() => {
    if (!postId || !enabled) {
      setCollab(null)
      setStatus("disconnected")
      setUsers([])
      return
    }
    const instance = acquirePostCollab(postId)
    setCollab(instance)
    const awareness = instance.provider.awareness
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
    const offStatus = instance.onStatus(onStatus)
    const offStale = instance.onStale(() => setGeneration((g) => g + 1))
    awareness?.on("change", onUsers)
    return () => {
      cancelAnimationFrame(raf)
      offStatus()
      offStale()
      awareness?.off("change", onUsers)
      releasePostCollab(instance)
    }
  }, [postId, enabled, generation])

  const clientId = collab?.provider.awareness?.clientID
  return { status, users: clientId != null ? users.filter((u) => u.clientId !== clientId) : users }
}

export const useCollabPresence = usesHocuspocus() ? useHocuspocusPresence : useYWebsocketPresence
