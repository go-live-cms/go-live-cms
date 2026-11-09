import { apiCall } from "../api"
import type { Media } from "./types"
import { buildUrl } from "./utils"

// The command palette's data (#41): api/command_palette.go. One call, so one request to
// cancel when the text changes, and the API alone decides who gets which group.

export interface CommandPalettePost {
  id: number
  title: string
  post_type: string
  post_status: string
}

export interface CommandPaletteTerm {
  id: number
  name: string
  slug: string
  taxonomy_type: string
  taxonomy_label: string
}

export interface CommandPaletteUser {
  id: number
  username: string
  full_name: string
  avatar: string | null
  role: string
}

export interface CommandPaletteResults {
  posts: CommandPalettePost[]
  pages: CommandPalettePost[]
  media: Media[]
  terms: CommandPaletteTerm[]
  /** Admins only: the API leaves the key out for anyone else. */
  users?: CommandPaletteUser[]
}

export async function searchCommandPalette(q: string, signal?: AbortSignal): Promise<CommandPaletteResults> {
  const res = await apiCall(buildUrl("/search", { q: q.trim() }), { signal })
  return { posts: res?.posts ?? [], pages: res?.pages ?? [], media: res?.media ?? [], terms: res?.terms ?? [], users: res?.users }
}
