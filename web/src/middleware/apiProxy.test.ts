import { describe, expect, it, vi } from "vitest"
import { CAPTIONS_CONTENT_TYPE, isApiProxyPath, isCaptionsPath, proxyToApi } from "./apiProxy"
import { log } from "../lib/log"
import { runWithLogContext } from "./requestContext"

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

  it("sends the API the request id the web logs under", async () => {
    const fetchImpl = upstream({ status: 200 })
    const req = new Request("https://cms.example.com/api/v1/posts", { headers: { "X-Request-ID": "bad id" } })

    await runWithLogContext({ request_id: "req-12345678" }, () => proxyToApi(req, "198.51.100.7", "http://api:8080", fetchImpl))

    expect((fetchImpl.mock.calls[0][1]?.headers as Headers).get("x-request-id")).toBe("req-12345678")
  })

  it("serves a captions file under /uploads as WebVTT, never sniffed (#507)", async () => {
    expect(isCaptionsPath("/uploads/media/tour-en-0a1b.vtt")).toBe(true)
    expect(isCaptionsPath("/uploads/media/TOUR.VTT")).toBe(true)
    expect(isCaptionsPath("/uploads/media/tour.txt")).toBe(false)
    expect(isCaptionsPath("/api/v1/media/x.vtt")).toBe(false)

    // Whatever the upstream said (text/plain from a sniffing server), the browser gets text/vtt.
    const fetchImpl = upstream({ status: 200, body: "WEBVTT\n", headers: { "Content-Type": "text/plain; charset=utf-8" } })
    const res = await proxyToApi(new Request("https://cms.example.com/uploads/media/tour-en-0a1b.vtt"), "198.51.100.7", "http://api:8080", fetchImpl)
    expect(res.headers.get("content-type")).toBe(CAPTIONS_CONTENT_TYPE)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await res.text()).toBe("WEBVTT\n")

    // A 404 keeps the API's JSON error.
    const missing = upstream({ status: 404, body: '{"error":"not found"}', headers: { "Content-Type": "application/json" } })
    const notFound = await proxyToApi(new Request("https://cms.example.com/uploads/media/gone.vtt"), "198.51.100.7", "http://api:8080", missing)
    expect(notFound.headers.get("content-type")).toBe("application/json")

    // Other uploads keep the upstream's type.
    const image = upstream({ status: 200, body: "x", headers: { "Content-Type": "image/png" } })
    const png = await proxyToApi(new Request("https://cms.example.com/uploads/media/a.png"), "198.51.100.7", "http://api:8080", image)
    expect(png.headers.get("content-type")).toBe("image/png")
  })

  it("drops Expect, which Node's fetch refuses to send", async () => {
    const fetchImpl = upstream({ status: 200 })
    const req = new Request("https://cms.example.com/api/v1/media", {
      method: "POST",
      headers: { "Content-Type": "application/json", Expect: "100-continue" },
      body: "{}",
    })

    const res = await proxyToApi(req, "198.51.100.7", "http://api:8080", fetchImpl)

    expect(res.status).toBe(200)
    expect((fetchImpl.mock.calls[0][1]?.headers as Headers).has("expect")).toBe(false)
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
    vi.spyOn(log, "error").mockImplementation(() => {})

    const res = await proxyToApi(new Request("http://localhost:4321/api/v1/posts"), "10.0.0.1", "http://api:8080", fetchImpl)

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "API unavailable" })
  })
})
