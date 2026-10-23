// Which collaboration server this build talks to (#206 P3, #283).
//
// PUBLIC_COLLAB_BACKEND is read at BUILD time (Astro inlines PUBLIC_* vars), and it is
// deployment-wide, never per user: two backends serving one post would fork the doc. It
// must match the API's COLLAB_BACKEND.
//   - "y-websocket" (default): CollaborationProvider + BlockPersistenceManager (REST autosave).
//   - "hocuspocus": HocuspocusCollaboration + CollabSaveStatus; the server seeds and saves.

export type CollabBackend = "y-websocket" | "hocuspocus"

export function parseCollabBackend(value: unknown): CollabBackend {
  return value === "hocuspocus" ? "hocuspocus" : "y-websocket"
}

export const COLLAB_BACKEND: CollabBackend = parseCollabBackend(import.meta.env.PUBLIC_COLLAB_BACKEND)

export const usesHocuspocus = (): boolean => COLLAB_BACKEND === "hocuspocus"

/**
 * The Hocuspocus server's WebSocket URL.
 *   - PUBLIC_COLLAB_URL, if set (e.g. an isolated dev stack on another port);
 *   - dev: port 1235 on the page's own host name, so `localhost:4321` and
 *     `127.0.0.1:4321` (two logins side by side) each reach it;
 *   - production: `/collab` on the page's origin, which Caddy forwards (#288).
 * Never carries a credential: the ticket travels in Hocuspocus's auth message.
 */
export function hocuspocusUrl(
  location: Pick<Location, "protocol" | "host" | "hostname">,
  env: { DEV?: boolean; PUBLIC_COLLAB_URL?: string } = import.meta.env
): string {
  if (env.PUBLIC_COLLAB_URL) return env.PUBLIC_COLLAB_URL
  const protocol = location.protocol === "https:" ? "wss:" : "ws:"
  return env.DEV ? `${protocol}//${location.hostname}:1235` : `${protocol}//${location.host}/collab`
}
