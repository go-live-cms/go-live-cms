import type { BlockDocV1 } from "../blocks-spec"
import { ApiError } from "./errors"

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

// What a version stores besides its blocks (#358): the settings the site shows. null for a
// version published before they were saved.
export interface PostSettings {
  title: string
  description: string
  featured_image: { id: number | null; url: string } | null
  term_ids: number[]
}

export interface PostVersion extends PostVersionSummary {
  doc: BlockDocV1
  settings?: PostSettings | null
}

// GET /posts/:id/settings: the working settings, the published ones (null when nothing is
// published) and whether a change waits for Update.
export interface PostSettingsState {
  working: PostSettings
  published: PostSettings | null
  // The settings differ from the published ones (#358).
  changed: boolean
  // A published post's body differs from the published one (#326).
  blocks_changed: boolean
  // Published, with either of the two: "Changes not published" (#326).
  has_unpublished_changes: boolean
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

  // fetch with auth headers + cookies. A 401 becomes UnauthorizedError; any other non-2xx
  // becomes ApiError("Failed to <what>: <statusText>") with the status and request id.
  private async request(path: string, what: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseURL}${path}`, this.buildInit({ headers: this.getHeaders(), ...init }))

    if (response.status === 401) {
      throw new UnauthorizedError()
    }

    if (!response.ok) {
      // An ApiError so callers can tell a 503 (publish: the collab flush failed) apart and
      // show the error ID; the message stays the same.
      throw new ApiError(`Failed to ${what}: ${response.statusText}`, response.status, null, null, null, response.headers.get("X-Request-ID"))
    }

    return response
  }

  // Get the working copy (read-only: only the collab server writes it)
  async getPostBlocks(postId: number): Promise<{ doc: BlockDocV1 }> {
    const response = await this.request(`/posts/${postId}/blocks`, "get post blocks")
    const data = await response.json()
    return { doc: data.doc }
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
  }

  // Whether a published post's settings changed since its last publish (#358)
  async getSettingsState(postId: number): Promise<PostSettingsState> {
    const response = await this.request(`/posts/${postId}/settings`, "get post settings")
    return response.json()
  }

  // Put a version's settings back into the working copy (#358), after its blocks were
  // restored in the editor. `restored` is false for a version without saved settings.
  async restoreVersionSettings(postId: number, versionNo: number): Promise<{ restored: boolean; post?: { title: string; description: string } }> {
    const response = await this.request(`/posts/${postId}/versions/${versionNo}/restore-settings`, "restore the version's settings", {
      method: "POST",
    })
    return response.json()
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

// Custom error for unauthorized access
export class UnauthorizedError extends Error {
  constructor(message: string = "Unauthorized") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

// Singleton instance
export const blockAPIClient = new BlockAPIClient()
