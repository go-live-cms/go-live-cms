import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { BlockAPIClient, UnauthorizedError } from "./blockAPI"

// #136: unpublish + revisions endpoints
describe("BlockAPIClient revisions/unpublish", () => {
  const fetchMock = vi.fn()
  let client: BlockAPIClient

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    client = new BlockAPIClient("/api/v1")
    client.setAuthToken("tok")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("unpublishPost POSTs to /unpublish with auth and cookies", async () => {
    fetchMock.mockResolvedValueOnce(json({ post: { id: 3, post_status: "draft" } }))
    await client.unpublishPost(3)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/posts/3/unpublish")
    expect(init.method).toBe("POST")
    expect(init.credentials).toBe("include")
    expect(init.headers.Authorization).toBe("Bearer tok")
  })

  it("listVersions returns the server payload", async () => {
    const payload = {
      post_status: "published",
      published_version_id: 9,
      versions: [{ id: 9, version_no: 2, status: "published", is_published: true }],
    }
    fetchMock.mockResolvedValueOnce(json(payload))

    await expect(client.listVersions(3)).resolves.toEqual(payload)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/posts/3/versions")
  })

  it("getVersion fetches one version by number, doc included", async () => {
    const doc = { doc_version: 1, blocks_order: [], blocks: {} }
    fetchMock.mockResolvedValueOnce(json({ id: 9, version_no: 2, doc }))

    const v = await client.getVersion(3, 2)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/posts/3/versions/2")
    expect(v.doc).toEqual(doc)
  })

  it("maps 401 to UnauthorizedError and other failures to Error", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
    await expect(client.unpublishPost(3)).rejects.toBeInstanceOf(UnauthorizedError)

    fetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403))
    await expect(client.listVersions(3)).rejects.toThrow(/Failed to list versions/)

    fetchMock.mockResolvedValueOnce(json({ error: "version not found" }, 404))
    await expect(client.getVersion(3, 7)).rejects.toThrow(/Failed to get version 7/)
  })
})
