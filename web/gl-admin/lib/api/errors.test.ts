import { describe, expect, it } from "vitest"
import { ApiError, apiErrorFromResponse, errorMessage, friendlyApiMessage } from "./errors"

const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

describe("apiErrorFromResponse", () => {
  it("turns a bare 403 from the role middleware into a permission message", async () => {
    const err = await apiErrorFromResponse(respond(403, JSON.stringify({ error: "forbidden" })))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.serverMessage).toBe("forbidden")
    expect(err.message).toMatch(/don't have permission/)
  })

  it("keeps a specific 403 reason", async () => {
    const err = await apiErrorFromResponse(respond(403, JSON.stringify({ error: "you can only delete your own media" })))
    expect(err.message).toBe("You can only delete your own media.")
  })

  it("explains a 404", async () => {
    const err = await apiErrorFromResponse(respond(404, JSON.stringify({ error: "post not found" })))
    expect(err.message).toBe("Post not found. It may have been deleted or moved.")
  })

  it("tells the user how long to wait on a 429 (rate limit, #190)", async () => {
    const err = await apiErrorFromResponse(
      respond(429, JSON.stringify({ error: "too many requests, try again later" }), { "Retry-After": "12" })
    )
    expect(err.retryAfterSeconds).toBe(12)
    expect(err.message).toBe("You're doing that too often. Please wait 12 seconds and try again.")
  })

  it("never shows a raw non-JSON body", async () => {
    const err = await apiErrorFromResponse(
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })
    )
    expect(err.message).not.toMatch(/html|Bad Gateway/)
    expect(err.message).toMatch(/went wrong on the server/)
  })

  it("hides internal 500 messages", async () => {
    const err = await apiErrorFromResponse(respond(500, JSON.stringify({ error: "failed to list posts" })))
    expect(err.message).not.toMatch(/failed to list posts/)
  })

  it("shows validation messages and falls back when there is none", async () => {
    expect((await apiErrorFromResponse(respond(400, JSON.stringify({ error: "invalid limit parameter" })))).message).toBe(
      "Invalid limit parameter."
    )
    expect((await apiErrorFromResponse(respond(400, ""), { fallback: "Upload failed" })).message).toBe("Upload failed")
  })
})

describe("friendlyApiMessage", () => {
  it("uses the server message for a 401 only on auth endpoints", () => {
    expect(friendlyApiMessage(401, { serverMessage: "invalid credentials", authEndpoint: true })).toBe("Invalid credentials.")
    expect(friendlyApiMessage(401, { serverMessage: "token revoked" })).toMatch(/session has expired/)
  })
})

describe("errorMessage", () => {
  it("maps network failures, plain errors and bugs", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/Couldn't reach the server/)
    expect(errorMessage(new Error("Title is required"))).toBe("Title is required")
    class RefreshError extends Error {}
    expect(errorMessage(new RefreshError("session is blocked"))).toBe("session is blocked")
    expect(errorMessage(new TypeError("Cannot read properties of undefined"), "Fallback")).toBe("Fallback")
    expect(errorMessage("nope", "Fallback")).toBe("Fallback")
  })
})
