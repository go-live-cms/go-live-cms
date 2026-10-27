import * as Y from "yjs"
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import { collabDebug, collabDebugEnabled, contentFingerprint, fragmentStructure } from "./debug"

// The client side of the Hocuspocus collab server (#206; server: web/collab-server).
//
// The client is a bound editor and nothing else: it never seeds the doc and never saves
// content. The server seeds a new doc from posts.block_doc and stores both the Yjs state
// and the derived block_doc, then tells every client with a stateless message.
//
//   - Auth: `token` fetches a fresh single-use ticket (POST /collab/tickets) on every
//     connect and reconnect. It travels in Hocuspocus's auth message, never the URL.
//   - Epoch: once synced, the doc's `meta.epoch` goes on the socket URL (`?epoch=`), so
//     every reconnect of this Y.Doc tells the server which seeding its structs belong
//     to. The server refuses a mismatch with `stale-epoch` (it reseeded since, e.g. after
//     block_doc was written around it); merging these structs would duplicate the
//     content, so this instance is then dead: `onStale` listeners remount with a fresh
//     instance (and a fresh Y.Doc). The server-side counterpart of rule 0.
//   - Store results: `{type:"stored", revision, block_doc}` / `{type:"store_failed"}`,
//     surfaced through `onStore` (CollabSaveStatus).
//   - Access changes (#313): the server re-checks every open connection's access. A
//     demotion (or an API outage past its grace period) makes the connection read-only
//     and sends `{type:"access", mode, reason}`; losing access altogether closes it with
//     `access-revoked`. Both surface through `onAccess`: the editor turns view-only and
//     keeps its local state; after a revoke this instance never reconnects (sign in again).
//   - No resyncInterval: Hocuspocus has no periodic resync, so there is no "2s" cadence.

/** Rejection reasons the server sends (web/collab-server/auth.ts DENY). */
export const DENY_REASON = {
  forbidden: "permission-denied",
  unavailable: "access-unavailable",
  staleEpoch: "stale-epoch",
} as const

/** The close reason when the server's access re-check revokes a session (web/collab-server/recheck.ts). */
export const ACCESS_REVOKED = "access-revoked"

/** Sent to one connection when the server changes its mode (web/collab-server/recheck.ts AccessMessage). */
export interface AccessMessage {
  type: "access"
  mode: "read" | "write"
  reason: "demoted" | "unverified" | "restored"
}

/** What this connection may do now, as far as the server has said. */
export interface CollabAccess {
  readOnly: boolean
  /** Why the server last changed the mode while connected (null: as authorized at connect). */
  reason: AccessMessage["reason"] | null
  /** The server ended the session (access-revoked): no reconnects; sign in again. */
  revoked: boolean
}

/** Sent with broadcastStateless after each store attempt (web/collab-server/server.ts). */
export type StoreMessage =
  | { type: "stored"; revision: number | null; block_doc: "written" | "kept-invalid" | "kept-empty" | "unchanged" }
  | { type: "store_failed" }

export type HocuspocusStatus = "connecting" | "connected" | "disconnected" | "denied" | "revoked"

export const META_MAP = "meta"

export interface CollabUserInfo {
  name: string
  color: string
  id: number
}

export interface HocuspocusCollaborationOptions {
  /** The server's WebSocket URL, without `?epoch=` (backend.ts hocuspocusUrl). */
  url: string
  /** A fresh collab ticket for `docName`. Called on every (re)connect. */
  getTicket: (docName: string) => Promise<string>
  user?: CollabUserInfo
  WebSocketPolyfill?: unknown
  /** First delay before retrying a connection the server couldn't authorize (doubles to 30s). */
  authRetryMs?: number
  /** HocuspocusProviderWebsocket reconnect delays (tests shorten them). */
  reconnectDelayMs?: number
}

/** `url` with `?epoch=` set (or replaced). */
export function urlWithEpoch(url: string, epoch: string | null): string {
  const [base, query = ""] = url.split("?", 2)
  const params = new URLSearchParams(query)
  if (epoch) params.set("epoch", epoch)
  else params.delete("epoch")
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

type Listener<T> = (value: T) => void

export class HocuspocusCollaboration {
  readonly doc: Y.Doc
  readonly provider: HocuspocusProvider
  readonly socket: HocuspocusProviderWebsocket
  readonly docName: string
  readonly postId: number

  private readonly baseUrl: string
  private readonly authRetryMs: number
  private authRetryDelay: number
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null
  private epoch: string | null = null
  private status: HocuspocusStatus = "connecting"
  private _stale = false
  private _destroyed = false
  /** Set by an access message; cleared by the next authentication (a fresh lookup). */
  private accessOverride: AccessMessage | null = null
  private _revoked = false
  private readonly listeners = {
    store: new Set<Listener<StoreMessage>>(),
    access: new Set<Listener<CollabAccess>>(),
    stale: new Set<Listener<void>>(),
    status: new Set<Listener<HocuspocusStatus>>(),
    synced: new Set<Listener<void>>(),
  }

  constructor(postId: number, options: HocuspocusCollaborationOptions) {
    this.postId = postId
    this.docName = `post-${postId}`
    this.baseUrl = options.url
    this.authRetryMs = options.authRetryMs ?? 1000
    this.authRetryDelay = this.authRetryMs
    this.doc = new Y.Doc()

    const delay = options.reconnectDelayMs
    this.socket = new HocuspocusProviderWebsocket({
      url: this.baseUrl,
      ...(options.WebSocketPolyfill ? { WebSocketPolyfill: options.WebSocketPolyfill as never } : {}),
      ...(delay !== undefined ? { delay, minDelay: delay, maxDelay: Math.max(delay, 5000), initialDelay: 0 } : {}),
    })
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: this.docName,
      document: this.doc,
      // Called on every connect and reconnect: tickets are single use and live 30s.
      token: async () => options.getTicket(this.docName),
      onSynced: () => this.handleSynced(),
      onAuthenticated: () => this.handleAuthenticated(),
      onAuthenticationFailed: ({ reason }) => this.handleAuthFailed(reason),
      onStateless: ({ payload }) => this.handleStateless(payload),
      onClose: ({ event }) => {
        if (event?.reason === ACCESS_REVOKED) this.handleRevoked()
      },
      onStatus: ({ status }) => {
        if (this.status !== "denied" && this.status !== "revoked") this.setStatus(status as HocuspocusStatus)
      },
    })
    if (options.user) this.provider.setAwarenessField("user", options.user)
    this.provider.attach()

    if (collabDebugEnabled()) collabDebug("hocuspocus provider created", this.docName, this.fingerprint())
    this.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (!collabDebugEnabled()) return
      const from = origin === this.provider ? "remote" : origin == null ? "local" : String(origin)
      collabDebug("doc update", "origin", from, this.fingerprint(), "|", fragmentStructure(this.doc.getXmlFragment("default")))
    })
  }

  /** Synced with the server at least once since the last (re)connect. */
  get synced(): boolean {
    return this.provider.isSynced
  }

  /**
   * The server made this connection read-only: at connect (a contributor on someone else's
   * post), by a later access change (#313), or by ending the session.
   */
  get readOnly(): boolean {
    if (this._revoked) return true
    if (this.accessOverride) return this.accessOverride.mode === "read"
    return this.provider.authorizedScope === "readonly"
  }

  get revoked(): boolean {
    return this._revoked
  }

  getAccess(): CollabAccess {
    return { readOnly: this.readOnly, reason: this.accessOverride?.reason ?? null, revoked: this._revoked }
  }

  /** Refused with stale-epoch: this Y.Doc must not be used again (remount). */
  get stale(): boolean {
    return this._stale
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  getStatus(): HocuspocusStatus {
    return this.status
  }

  /** The epoch this doc last synced under (null before the first sync). */
  getEpoch(): string | null {
    return this.epoch
  }

  onStore(listener: Listener<StoreMessage>): () => void {
    return this.subscribe("store", listener)
  }
  /** Access changes while connected (#313): downgrade, restore, revoke. */
  onAccess(listener: Listener<CollabAccess>): () => void {
    return this.subscribe("access", listener)
  }
  onStale(listener: Listener<void>): () => void {
    return this.subscribe("stale", listener)
  }
  onStatus(listener: Listener<HocuspocusStatus>): () => void {
    return this.subscribe("status", listener)
  }
  /** Every (re)sync. */
  onSynced(listener: Listener<void>): () => void {
    return this.subscribe("synced", listener)
  }

  /** Resolves on the next sync, or now if synced. */
  whenSynced(): Promise<void> {
    if (this.synced) return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.onSynced(() => {
        off()
        resolve()
      })
    })
  }

  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer)
    for (const set of Object.values(this.listeners)) set.clear()
    this.provider.destroy()
    this.socket.destroy()
    this.doc.destroy()
  }

  private subscribe<K extends keyof typeof this.listeners>(
    kind: K,
    listener: (typeof this.listeners)[K] extends Set<infer L> ? L : never
  ): () => void {
    const set = this.listeners[kind] as Set<typeof listener>
    set.add(listener)
    return () => set.delete(listener)
  }

  private emit<K extends keyof typeof this.listeners>(
    kind: K,
    value: (typeof this.listeners)[K] extends Set<Listener<infer T>> ? T : never
  ): void {
    for (const listener of [...(this.listeners[kind] as Set<Listener<typeof value>>)]) {
      try {
        listener(value)
      } catch (error) {
        console.error(`[collab] ${String(kind)} listener failed:`, error)
      }
    }
  }

  private setStatus(status: HocuspocusStatus) {
    if (this.status === status) return
    this.status = status
    if (collabDebugEnabled()) collabDebug("ws status", status, this.fingerprint())
    this.emit("status", status)
  }

  private handleSynced() {
    this.authRetryDelay = this.authRetryMs
    // Authenticated after all (the socket's own reconnect got there first): a retry
    // scheduled for the failure would close this healthy connection.
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer)
      this.authRetryTimer = null
    }
    // Every later reconnect of this Y.Doc names the epoch its structs belong to.
    const epoch = this.doc.getMap(META_MAP).get("epoch")
    if (typeof epoch === "string" && epoch && epoch !== this.epoch) {
      this.epoch = epoch
      this.socket.configuration.url = urlWithEpoch(this.baseUrl, epoch)
    }
    if (collabDebugEnabled()) collabDebug("provider sync", true, "epoch", this.epoch, this.fingerprint())
    this.emit("synced", undefined)
  }

  private handleAuthenticated() {
    if (this._revoked) return
    // A (re)connect looked access up again: its scope is current.
    const wasReadOnly = this.readOnly
    const hadOverride = this.accessOverride !== null
    this.accessOverride = null
    if (hadOverride || wasReadOnly !== this.readOnly) this.emit("access", this.getAccess())
  }

  private handleRevoked() {
    if (this._revoked || this._destroyed) return
    console.warn(`[collab] ${this.docName}: the server ended this session (access revoked)`)
    this._revoked = true
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer)
    this.authRetryTimer = null
    this.setStatus("revoked")
    // The Y.Doc stays (the editor keeps showing it); this instance never reconnects.
    this.socket.disconnect()
    this.emit("access", this.getAccess())
  }

  private handleAuthFailed(reason: string) {
    if (this._destroyed) return
    collabDebug("authentication failed", reason)
    if (reason === DENY_REASON.staleEpoch) {
      // The server reseeded this doc: our structs belong to an older seeding. Never
      // reconnect with them; whoever holds this instance remounts with a new one.
      console.warn(`[collab] ${this.docName}: the document was reset on the server; reloading the editor`)
      this._stale = true
      this.emit("stale", undefined)
      this.destroy()
      return
    }
    if (reason === DENY_REASON.forbidden) {
      console.error(`[collab] ${this.docName}: access denied`)
      this.setStatus("denied")
      this.socket.disconnect()
      return
    }
    // access-unavailable, or the ticket fetch failed (network, a token refresh): close
    // and let the socket reconnect, which fetches a new ticket. Backoff up to 30s.
    const delay = this.authRetryDelay
    this.authRetryDelay = Math.min(delay * 2, 30_000)
    console.warn(`[collab] ${this.docName}: couldn't authenticate (${reason}); retrying in ${delay}ms`)
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer)
    this.authRetryTimer = setTimeout(() => {
      this.authRetryTimer = null
      if (this._destroyed) return
      const ws = this.socket.webSocket
      if (ws) ws.close()
      else void this.socket.connect()
    }, delay)
  }

  private handleStateless(payload: string) {
    let message: unknown
    try {
      message = JSON.parse(payload)
    } catch {
      return
    }
    const type = (message as { type?: unknown } | null)?.type
    if (type === "stored" || type === "store_failed") {
      collabDebug("store message", message)
      this.emit("store", message as StoreMessage)
      return
    }
    if (type === "access") {
      const { mode, reason } = message as Partial<AccessMessage>
      if ((mode !== "read" && mode !== "write") || this._revoked) return
      collabDebug("access message", message)
      this.accessOverride = { type: "access", mode, reason: reason ?? (mode === "read" ? "demoted" : "restored") }
      if (mode === "read") console.warn(`[collab] ${this.docName}: the server made this session read-only (${reason})`)
      // Writable again, but the server dropped what this doc sent while it was read-only
      // (Hocuspocus acks those updates as not applied, so they stay counted as unsynced).
      // Yjs never resends them, so every later update would wait on the server for the
      // missing ones and never be stored. Reconnect: the sync handshake sends them.
      if (mode === "write" && this.provider.hasUnsyncedChanges) {
        collabDebug("resyncing after a promotion: updates were dropped while read-only")
        this.socket.webSocket?.close()
      }
      this.emit("access", this.getAccess())
    }
  }

  private fingerprint(): string {
    return contentFingerprint(this.doc.getXmlFragment("default").toJSON())
  }
}

// Per-post registry: the editor, the schema gate and the presence hook share one
// connection per post. Ref-counted; destroyed shortly after the last release (StrictMode
// mounts twice). A stale instance is never handed out again.
const instances = new Map<number, { instance: HocuspocusCollaboration; refs: number; timer: number | null }>()
const DESTROY_DELAY_MS = 750

export function acquireHocuspocus(postId: number, create: () => HocuspocusCollaboration): HocuspocusCollaboration {
  const entry = instances.get(postId)
  if (entry && !entry.instance.stale && !entry.instance.destroyed && !entry.instance.revoked) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.refs++
    return entry.instance
  }
  const instance = create()
  instances.set(postId, { instance, refs: 1, timer: null })
  return instance
}

export function releaseHocuspocus(instance: HocuspocusCollaboration): void {
  const entry = instances.get(instance.postId)
  if (!entry || entry.instance !== instance) {
    // Replaced after going stale; it destroyed itself already.
    instance.destroy()
    return
  }
  entry.refs--
  if (entry.refs > 0) return
  entry.timer = setTimeout(() => {
    if (instances.get(instance.postId) === entry) instances.delete(instance.postId)
    instance.destroy()
  }, DESTROY_DELAY_MS) as unknown as number
}
