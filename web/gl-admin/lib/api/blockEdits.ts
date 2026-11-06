import { apiCall } from "../api"

// Per-block "Last edited by" (#328): api/post_block_edits.go. Written only by the collab
// server's store; read here once the editor opens a post (after that, the server's
// `stored` messages carry the rows it has just written, lib/blockEditsStore.ts).

export interface BlockEditPerson {
  id: number
  username: string
  full_name: string
  avatar: string | null
}

export interface BlockEdit {
  // null: a member removed since.
  user: BlockEditPerson | null
  edited_at: string
}

/** Block id → its last edit. A block with no entry shows no line. */
export type PostBlockEdits = Record<string, BlockEdit>

export async function getPostBlockEdits(postId: number): Promise<PostBlockEdits> {
  return (await apiCall(`/posts/${postId}/block-edits`)) ?? {}
}
