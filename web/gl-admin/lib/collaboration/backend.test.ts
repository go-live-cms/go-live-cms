import { describe, it, expect } from "vitest"
import { hocuspocusUrl } from "./backend"

describe("collab server URL (#206)", () => {
  it("dev: port 1235 on the page's own host name (localhost and 127.0.0.1 logins both reach it)", () => {
    expect(hocuspocusUrl({ protocol: "http:", host: "localhost:4321", hostname: "localhost" }, { DEV: true })).toBe(
      "ws://localhost:1235"
    )
    expect(hocuspocusUrl({ protocol: "http:", host: "127.0.0.1:4321", hostname: "127.0.0.1" }, { DEV: true })).toBe(
      "ws://127.0.0.1:1235"
    )
  })

  it("production: /collab on the page's origin (Caddy), wss under https", () => {
    expect(hocuspocusUrl({ protocol: "https:", host: "cms.example.com", hostname: "cms.example.com" }, { DEV: false })).toBe(
      "wss://cms.example.com/collab"
    )
  })

  it("PUBLIC_COLLAB_URL overrides both", () => {
    expect(
      hocuspocusUrl({ protocol: "http:", host: "localhost:4321", hostname: "localhost" }, { DEV: true, PUBLIC_COLLAB_URL: "ws://localhost:11235" })
    ).toBe("ws://localhost:11235")
  })
})
