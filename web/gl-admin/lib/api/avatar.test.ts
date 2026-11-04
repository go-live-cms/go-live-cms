import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({
  token: "stale",
  getState() {
    return { accessToken: this.token }
  },
  forceRefresh: vi.fn(),
}))
vi.mock("../auth", () => ({ authManager: auth }))

import { uploadAvatar } from "./users"

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  auth.token = "stale"
  auth.forceRefresh.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

// #334: like apiCall, a 401 gets one real refresh and one retry.
describe("uploadAvatar", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" })

  it("sends the file and the focal point", async () => {
    fetchMock.mockResolvedValue(json(200, { user: { id: 1 } }))
    await uploadAvatar(file, { x: 0.25, y: 0.75 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/users/me/avatar")
    expect(init.method).toBe("PUT")
    const form = init.body as FormData
    expect((form.get("file") as File).name).toBe("me.png")
    expect(form.get("focal_x")).toBe("0.25")
    expect(form.get("focal_y")).toBe("0.75")
  })

  it("refreshes once on a 401 and retries with the new token", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: "token expired" })).mockResolvedValueOnce(json(200, { user: { id: 1 } }))
    auth.forceRefresh.mockImplementation(async () => {
      auth.token = "fresh"
      return true
    })
    await expect(uploadAvatar(file)).resolves.toEqual({ user: { id: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer fresh")
  })

  it("gives up when the refresh fails", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "revoked" }))
    auth.forceRefresh.mockResolvedValue(false)
    await expect(uploadAvatar(file)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})