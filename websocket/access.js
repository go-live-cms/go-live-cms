// Role-based access control for collab connections (#216).
//
// The PASETO `role` claim is informational only: it goes stale on demotion and is empty
// on tokens issued by refresh (see token/payload.go). So the caller's CURRENT role is
// fetched from the API (GET /users/me reads it from the DB) on every upgrade, the same
// way api/auth_roles.go's requireRole does for REST requests.
//
// Pure + dependency-injected (fetchImpl) so it's unit tested in access.test.js. Must NOT
// import yjs — see the single-yjs-instance gotcha in websocket/CLAUDE.md.

// Roles allowed to edit post content. Mirrors requireContentEditor in
// api/auth_roles.go, which is the source of truth — keep the two in sync.
export const CONTENT_EDITOR_ROLES = ["admin", "editor"];

// Case-insensitive, matching the API's strings.EqualFold role comparison.
export function canEditContent(role) {
  if (typeof role !== "string" || !role) return false;
  const normalized = role.toLowerCase();
  return CONTENT_EDITOR_ROLES.includes(normalized);
}

// The only doc names the editor opens (`post-${postId}` in CollaborationProvider.ts).
// Anything else is rejected before auth, so a client can't make the server create and
// persist Yjs docs under arbitrary names, or put crafted text into log lines.
const COLLAB_DOC_NAME = /^post-[1-9]\d{0,18}$/;

export function isCollabDocName(name) {
  return typeof name === "string" && COLLAB_DOC_NAME.test(name);
}

// Reads the credential from an upgrade request (?ticket=, or legacy ?token=) and strips
// the query string and fragment from req.url, so nothing downstream (y-websocket's
// setupWSConnection, the connection handler, any log) can see the token (#220).
// Returns null when neither param is present.
export function takeCredential(req) {
  const raw = req.url || "/";
  const params = new URLSearchParams(raw.split("#")[0].split("?").slice(1).join("?"));
  req.url = raw.split("?")[0].split("#")[0];
  return params.get("ticket") || params.get("token") || null;
}

// Fetches the caller's current role from the API.
//
// Returns:
//   - the role string on 200
//   - null on 401/403/404 (token rejected or user deleted) → caller denies (403)
// Throws on any other status, a network error or a timeout → caller answers 503.
// Either way the connection is never allowed without a verified editor role.
export async function fetchCurrentRole(apiUrl, token, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const url = `${apiUrl.replace(/\/+$/, "")}/users/me`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`role lookup failed: API responded ${res.status}`);

  const body = await res.json();
  const role = body?.user?.role;
  return typeof role === "string" ? role : null;
}
