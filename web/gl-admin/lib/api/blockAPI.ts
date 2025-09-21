import type { BlockDocV1 } from "../blocks-spec"

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

  // Get working copy of post blocks
  async getPostBlocks(postId: number): Promise<{ doc: BlockDocV1; revision: number }> {
    const response = await fetch(
      `${this.baseURL}/posts/${postId}/blocks`,
      this.buildInit({
        headers: this.getHeaders(),
      })
    )

    if (response.status === 401) {
      throw new UnauthorizedError()
    }

    if (!response.ok) {
      throw new Error(`Failed to get post blocks: ${response.statusText}`)
    }

    const data = await response.json()
    const revision = parseInt(response.headers.get("X-Revision") || "0")

    return {
      doc: data.doc,
      revision,
    }
  }

  // Update working copy with optimistic concurrency
  async updatePostBlocks(
    postId: number,
    doc: BlockDocV1,
    revision: number
  ): Promise<{ doc: BlockDocV1; revision: number }> {
    const response = await fetch(
      `${this.baseURL}/posts/${postId}/blocks`,
      this.buildInit({
        method: "PUT",
        headers: {
          ...this.getHeaders(),
          "If-Match": revision.toString(),
        },
        body: JSON.stringify({ doc }),
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
    const response = await fetch(
      `${this.baseURL}/posts/${postId}/publish`,
      this.buildInit({
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ label, message }),
      })
    )

    if (response.status === 401) {
      throw new UnauthorizedError()
    }

    if (!response.ok) {
      throw new Error(`Failed to publish post: ${response.statusText}`)
    }

    const data = await response.json()
    return {
      versionId: data.version_id,
      versionNo: data.version_no,
    }
  }

  // Get published blocks (for preview/SSR)
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
