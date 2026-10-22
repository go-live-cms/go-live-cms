import type { BlockDocV1 } from "../blocks-spec"

// A published snapshot from post_versions (#136)
export interface PostVersionSummary {
  id: number
  version_no: number
  status: string
  label: string | null
  message: string | null
  created_at: string
  created_by: number | null
  created_by_username: string | null
  is_published?: boolean
}

export interface PostVersionList {
  post_status: string
  published_version_id: number | null
  versions: PostVersionSummary[]
}

export interface PostVersion extends PostVersionSummary {
  doc: BlockDocV1
}

// API client for Block Spec v1 operations
export class BlockAPIClient {
  private baseURL: string
  private authToken: string | null = null

  constructor(baseURL: string = "/api/v1") {
    this.baseURL = baseURL
  }

  setAuthToken(token: string) {
    this.authToken = token
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`
    }

    return headers
  }

  private buildInit(init: RequestInit = {}): RequestInit {
    return { credentials: "include", ...init }
  }

  // fetch with auth headers + cookies. A 401 becomes UnauthorizedError (the collab
  // persistence layer suspends on it); any other non-2xx becomes
  // Error("Failed to <what>: <statusText>").
  private async request(path: string, what: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseURL}${path}`, this.buildInit({ headers: this.getHeaders(), ...init }))

    if (response.status === 401) {
      throw new UnauthorizedError()
    }

    if (!response.ok) {
      throw new Error(`Failed to ${what}: ${response.statusText}`)
    }

    return response
  }

  // Get working copy of post blocks
  async getPostBlocks(postId: number): Promise<{ doc: BlockDocV1; revision: number }> {
    const response = await this.request(`/posts/${postId}/blocks`, "get post blocks")

    const data = await response.json()
    const revision = parseInt(response.headers.get("X-Revision") || "0")

    return {
      doc: data.doc,
      revision,
    }
  }  // Update working copy with optimistic concurrency
  async updatePostBlocks(
    postId: number,
    doc: BlockDocV1,
    revision: number,
    title?: string
  ): Promise<{ doc: BlockDocV1; revision: number }> {
    const body: any = { doc }
    if (title) {
      body.title = title
    }

    const response = await fetch(
      `${this.baseURL}/posts/${postId}/blocks`,
      this.buildInit({
        method: "PUT",
        headers: {
          ...this.getHeaders(),
          "If-Match": revision.toString(),
        },
        body: JSON.stringify(body),
      })
    )

    if (response.status === 412) {
      throw new ConflictError("Revision conflict - document was modified by another user")
    }

    if (response.status === 401) {
      throw new UnauthorizedError()
    }

    if (!response.ok) {
      throw new Error(`Failed to update post blocks: ${response.statusText}`)
    }

    const data = await response.json()
    const newRevision = parseInt(response.headers.get("X-Revision") || "0")

    return {
      doc: data.doc,
      revision: newRevision,
    }
  }

  // Publish current working copy
  async publishPost(
    postId: number,
    label?: string,
    message?: string
  ): Promise<{ versionId: number; versionNo: number }> {
    const response = await this.request(`/posts/${postId}/publish`, "publish post", {
      method: "POST",
      body: JSON.stringify({ label, message }),
    })

    const data = await response.json()
    return {
      versionId: data.version_id,
      versionNo: data.version_no,
    }
  }

  // Back to draft: the public snapshot is removed, versions are kept (#136)
  async unpublishPost(postId: number): Promise<void> {
    await this.request(`/posts/${postId}/unpublish`, "unpublish post", { method: "POST" })
  }

  // List published versions, newest first (no docs)
  async listVersions(postId: number): Promise<PostVersionList> {
    const response = await this.request(`/posts/${postId}/versions`, "list versions")
    return response.json()
  }

  // Get one version, including its Block Spec v1 doc
  async getVersion(postId: number, versionNo: number): Promise<PostVersion> {
    const response = await this.request(`/posts/${postId}/versions/${versionNo}`, `get version ${versionNo}`)
    return response.json()
  }  // Get published blocks (for preview/SSR)
  async getPublishedPostBlocks(postId: number): Promise<{ doc: BlockDocV1 }> {
    const response = await fetch(`/public/posts/${postId}/blocks`)

    if (!response.ok) {
      throw new Error(`Failed to get published post blocks: ${response.statusText}`)
    }

    return response.json()
  }
}

// Custom error for revision conflicts
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConflictError"
  }
}

// Custom error for unauthorized access
export class UnauthorizedError extends Error {
  constructor(message: string = "Unauthorized") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

// Singleton instance
export const blockAPIClient = new BlockAPIClient()
