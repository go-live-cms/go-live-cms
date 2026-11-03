import { beforeEach, describe, expect, it, vi } from "vitest"

// The missing alt text API calls (#325): the library filter's query parameter and the
// count Home's "Needs attention" (#324) reads.

const apiCall = vi.hoisted(() => vi.fn())
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  apiCall,
}))

import { getMedia, getMissingAltSummary } from "./media"

beforeEach(() => apiCall.mockReset())

describe("missing alt text", () => {
  it("getMedia sends missing_alt=true only when asked", async () => {
    apiCall.mockResolvedValue({ media: [], meta: { total: 0 } })
    await getMedia({ limit: 24, missing_alt: true })
    expect(apiCall).toHaveBeenLastCalledWith("/media?limit=24&missing_alt=true")
    await getMedia({ limit: 24, missing_alt: undefined })
    expect(apiCall).toHaveBeenLastCalledWith("/media?limit=24")
  })

  it("getMissingAltSummary reads GET /media/missing-alt", async () => {
    apiCall.mockResolvedValue({ media_count: 3, published_post_count: 2 })
    await expect(getMissingAltSummary()).resolves.toEqual({ media_count: 3, published_post_count: 2 })
    expect(apiCall).toHaveBeenCalledWith("/media/missing-alt")

    apiCall.mockResolvedValue({})
    await expect(getMissingAltSummary()).resolves.toEqual({ media_count: 0, published_post_count: 0 })
  })
})
