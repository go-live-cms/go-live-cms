import { describe, expect, it, vi } from "vitest"
import { isApiProxyPath, proxyToApi } from "./apiProxy"

describe("isApiProxyPath", () => {
  it("matches the Go API and uploads", () => {
    expect(isApiProxyPath("/api/v1")).toBe(true)
    expect(isApiProxyPath("/api/v1/auth/login")).toBe(true)
    expect(isApiProxyPath("/uploads/media/a.png")).toBe(true)
  })

  it("leaves Astro's own routes alone", () => {
    expect(isApiProxyPath("/api/theme/default/x")).toBe(false)
    expect(isApiProxyPath("/api/posts-reload")).toBe(false)
    expect(isApiProxyPath("/api/v10")).toBe(false)
    expect(isApiProxyPath("/gl-admin")).toBe(false)
  })
})

describe("proxyToApi", () => {
  function upstream(init: ResponseInit & { body?: string } = {}) {
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(init.body ?? "{}", init))
  }

  it("forwards path, query, method, body and appends the client IP", async () => {
    const fetchImpl = upstream({ status: 201 })
    const req = new Request("https://cms.example.com/api/v1/posts?page=2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9", Cookie: "a=b" },
      body: JSON.stringify({ title: "x" }),
    })

    const res = await proxyToApi(req, "198.51.100.7", "http://api:8080", fetchImpl)

    expect(res.status).toBe(201)
    const [target, init] = fetchImpl.mock.calls[0]
    expect(String(target)).toBe("http://api:8080/api/v1/posts?page=2")
    expect(init?.method).toBe("POST")
    const headers = init?.headers as Headers
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9, 198.51.100.7")
    expect(headers.get("x-forwarded-proto")).toBe("https")
    expect(headers.get("x-forwarded-host")).toBe("cms.example.com")
    expect(headers.get("cookie")).toBe("a=b")
    expect(headers.has("host")).toBe(false)
    expect(await new Response(init?.body as BodyInit).text()).toBe('{"title":"x"}')
  })

  it("sends no body for GET and keeps every Set-Cookie", async () => {
    const headers = new Headers({ "Content-Encoding": "gzip", "Content-Length": "999" })
    headers.append("Set-Cookie", "__Host-refresh_token=r; Path=/; Secure; HttpOnly")
    headers.append("Set-Cookie", "refresh_token=; Max-Age=0; Path=/api/v1/auth")
    const fetchImpl = upstream({ status: 200, headers })

    const res = await proxyToApi(new Request("http://localhost:4321/api/v1/users/me"), undefined, "http://api:8080", fetchImpl)

    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined()
    expect(res.headers.getSetCookie()).toHaveLength(2)
    expect(res.headers.has("content-encoding")).toBe(false)
    expect(res.headers.has("content-length")).toBe(false)
  })

  it("answers 502 when the API is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await proxyToApi(new Request("http://localhost:4321/api/v1/posts"), "10.0.0.1", "http://api:8080", fetchImpl)

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "API unavailable" })
  })
})
