// Where the collaboration server (Hocuspocus, web/collab-server/, #206) is reached.

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
