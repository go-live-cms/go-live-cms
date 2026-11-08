import { apiCall } from "../api"
import { buildUrl } from "./utils"

// The @ menu's data (#320): api/mentions.go. Members and posts the caller may link to,
// public fields only (never an email).

export interface MentionPerson {
  id: number
  username: string
  full_name: string
  avatar: string | null
  role: string
}

export interface MentionContent {
  id: number
  title: string
  post_type: string
  /** The type's label ("Post", "Page"). */
  post_type_label: string
  post_status: string
}

/** Members with a content role whose name or username contains `q` (everyone, by name, without). */
export async function searchMentionPeople(q: string): Promise<MentionPerson[]> {
  const res = await apiCall(buildUrl("/mentions/people", { q: q.trim() }))
  return res?.people ?? []
}

/** The members with these ids (the editor's current names for mentions); a removed member is left out. */
export async function getMentionPeople(ids: number[]): Promise<MentionPerson[]> {
  if (ids.length === 0) return []
  const res = await apiCall(buildUrl("/mentions/people", { ids: ids.join(",") }))
  return res?.people ?? []
}

/** Posts and pages the caller may read whose title contains `q` (the latest edited, without). */
export async function searchMentionContent(q: string): Promise<MentionContent[]> {
  const res = await apiCall(buildUrl("/mentions/content", { q: q.trim() }))
  return res?.posts ?? []
}
