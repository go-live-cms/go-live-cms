import { apiCall } from "../api"
import { buildUrl } from "./utils"

// The activity log and Home's lists (#324): GET /activity, /home/continue-editing and
// /home/needs-attention. What each role sees is the API's (api/CLAUDE.md, activity).

export interface ActivityPerson {
  id: number
  username: string
  full_name: string
}

export interface ActivityEvent {
  id: number
  // created, updated, edited, published, unpublished, scheduled, unscheduled, deleted,
  // version_restored, uploaded, replaced, invited, invitation_revoked, joined,
  // role_changed, removed, settings_updated; later features add their own.
  verb: string
  object_type: "post" | "media" | "user" | "invitation" | "settings" | string
  object_id: number
  created_at: string
  // null: the system, or a member removed since.
  actor: ActivityPerson | null
  // The object as it is now; absent once it's deleted.
  post?: { id: number; title: string; post_type: string; post_status: string }
  media?: { id: number; name: string }
  user?: ActivityPerson
  // Non-personal details: a role, a version number, setting names.
  payload: Record<string, unknown>
}

export interface ActivityPage {
  activity: ActivityEvent[]
  // Pass as `before` for the next page; null at the end.
  next_before: number | null
}

export async function getActivity(params: { limit?: number; before?: number | null; post_id?: number } = {}): Promise<ActivityPage> {
  const response = await apiCall(buildUrl("/activity", params))
  return { activity: response.activity ?? [], next_before: response.next_before ?? null }
}

export interface ContinueEditingPost {
  id: number
  title: string
  post_type: string
  post_status: string
  publish_at?: string | null
  // A pending scheduled Update's time (#335).
  update_at?: string | null
  has_unpublished_changes?: boolean
  schedule_failed?: boolean
  // When the caller last worked on it.
  edited_at: string
}

export async function getContinueEditing(params: { limit?: number } = {}): Promise<ContinueEditingPost[]> {
  const response = await apiCall(buildUrl("/home/continue-editing", params))
  return response.posts ?? []
}

export interface FailedSchedule {
  id: number
  title: string
  post_type: string
  publish_at?: string | null
  failed_at?: string | null
  reason: string
  attempts: number
}

export interface UnpublishedChangesPost {
  id: number
  title: string
  post_type: string
  changed_at: string
  last_editor: ActivityPerson | null
}

export interface AttentionList<T> {
  total: number
  posts: T[]
}

export interface NeedsAttention {
  failed_schedules: AttentionList<FailedSchedule>
  // null for roles that can't act on them (contributors).
  unpublished_changes: AttentionList<UnpublishedChangesPost> | null
  missing_alt: { media_count: number; published_post_count: number } | null
  // Review requests (#323): always empty until they exist.
  review_requests: unknown[]
}

export async function getNeedsAttention(): Promise<NeedsAttention> {
  const response = await apiCall("/home/needs-attention")
  return {
    failed_schedules: response.failed_schedules ?? { total: 0, posts: [] },
    unpublished_changes: response.unpublished_changes ?? null,
    missing_alt: response.missing_alt ?? null,
    review_requests: response.review_requests ?? [],
  }
}
