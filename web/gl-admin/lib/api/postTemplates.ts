import type { Post } from "./types"
import { authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"

// Post templates (#322, api/post_templates.go): a post's content saved under a name,
// per post type, optionally with its category and featured image. Any content role
// lists and uses them; admins and editors save, rename and delete them.

export interface PostTemplate {
  id: number
  post_type: string
  name: string
  // The saved settings: category terms, and the featured image's media id (null
  // when none was saved, or the image was deleted since).
  terms: { id: number; name: string }[]
  featured_image_id: number | null
  created_by_id: number | null
  created_by_name: string
  created_at: string
  changed_at: string
}

export async function listPostTemplates(postType: string): Promise<PostTemplate[]> {
  const response = await authenticatedFetch(`/api/v1/post-templates?type=${encodeURIComponent(postType)}`)
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Couldn't load the templates" })
  const body = (await response.json()) as { templates: PostTemplate[] }
  return body.templates ?? []
}

// Saves the post's working copy (the API flushes the collab server first) as a
// template of its type. with_settings also keeps its category and featured image.
export async function createPostTemplate(input: { post_id: number; name: string; with_settings: boolean }): Promise<PostTemplate> {
  const response = await authenticatedFetch("/api/v1/post-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Couldn't save the template" })
  return ((await response.json()) as { template: PostTemplate }).template
}

export async function renamePostTemplate(id: number, name: string): Promise<PostTemplate> {
  const response = await authenticatedFetch(`/api/v1/post-templates/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Couldn't rename the template" })
  return ((await response.json()) as { template: PostTemplate }).template
}

export async function deletePostTemplate(id: number): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/post-templates/${id}`, { method: "DELETE" })
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Couldn't delete the template" })
}

// A new draft owned by the caller, with the template's content (every block id new),
// category and featured image. The collab server seeds its document from that content
// the first time the editor opens it.
export async function createPostFromTemplate(id: number): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/post-templates/${id}/posts`, { method: "POST" })
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Couldn't start a post from the template" })
  return response.json()
}
