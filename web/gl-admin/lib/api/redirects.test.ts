import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", () => ({ apiCall: vi.fn() }))

import { apiCall } from "../api"
import { createRedirect, deleteRedirect, listRedirects } from "./redirects"

const mockedApiCall = vi.mocked(apiCall)

beforeEach(() => mockedApiCall.mockReset())

// The redirects routes (#331): admins only, newest first.
describe("redirects API client", () => {
  it("lists a page with its total", async () => {
    mockedApiCall.mockResolvedValue({ redirects: [{ id: 1 }], total: 7 })
    expect(await listRedirects({ limit: 20, offset: 20 })).toEqual({ redirects: [{ id: 1 }], total: 7 })
    expect(mockedApiCall).toHaveBeenCalledWith("/redirects?limit=20&offset=20")
  })

  it("leaves out an empty query and fills in a missing list", async () => {
    mockedApiCall.mockResolvedValue({})
    expect(await listRedirects({ q: "" })).toEqual({ redirects: [], total: 0 })
    expect(mockedApiCall).toHaveBeenCalledWith("/redirects")
  })

  it("creates and returns the redirect, and deletes by id", async () => {
    mockedApiCall.mockResolvedValueOnce({ redirect: { id: 9, from_path: "/a" } }).mockResolvedValueOnce({})
    expect(await createRedirect({ from_path: "/a", to_path: "/b", status_code: 302 })).toEqual({ id: 9, from_path: "/a" })
    await deleteRedirect(9)
    expect(mockedApiCall.mock.calls).toEqual([
      ["/redirects", { method: "POST", body: { from_path: "/a", to_path: "/b", status_code: 302 } }],
      ["/redirects/9", { method: "DELETE" }],
    ])
  })
})
