import { useEffect, useMemo, useState } from "react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"

export type CollabStatus = "connecting" | "connected" | "disconnected"
export type CollabUser = { clientId: number; id?: number; name?: string; color?: string }

export function useCollabPresence(postId?: number, enabled = true) {
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
    provider.provider.on("connect", onStatus)
    provider.provider.on("disconnect", onStatus)
    provider.provider.awareness.on("change", onUsers)

    return () => {
      cancelAnimationFrame(raf)
      provider.provider.off("status", onStatus)
      provider.provider.off("connect", onStatus)
      provider.provider.off("disconnect", onStatus)
      provider.provider.awareness.off("change", onUsers)
      // do not release here; Editor owns lifecycle
    }
  }, [provider])

  const clientId = provider?.provider.awareness.clientID
  const others = clientId != null ? users.filter((u) => u.clientId !== clientId) : users

  return { status, users: others }
}
