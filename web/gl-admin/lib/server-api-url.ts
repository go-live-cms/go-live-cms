// Server-side (SSR) base URL of the Go API, e.g. http://api:8080/api/v1.
// Read from process.env at runtime: non-PUBLIC import.meta.env vars are
// resolved at build time, which would ignore the value set in compose.
export const SERVER_API_URL: string = (
  (typeof process !== "undefined" && process.env?.SERVER_API_URL) ||
  "http://api:8080/api/v1"
).replace(/\/+$/, "")

// Same host without the /api/v1 suffix (used for /uploads media).
export const SERVER_MEDIA_URL: string = SERVER_API_URL.replace(/\/api\/v1$/, "")
