import { authManager } from "../auth"
import { createCollabTicket } from "../api/collab"
import { hocuspocusUrl } from "./backend"
import { acquireHocuspocus, HocuspocusCollaboration, releaseHocuspocus } from "./HocuspocusCollaboration"

// The app's Hocuspocus connection for a post: the server URL for this page, tickets from
// POST /collab/tickets, the signed-in user's cursor label. HocuspocusCollaboration itself
// takes these as options so tests can point it at an in-process server.

// The design's presence colours (--presence-1..8 in assets/styles/_tokens.scss,
// Radix step 11): white name labels pass 4.5:1 on each. Hex, not var(), because the
// colour travels to other clients over awareness.
export const PRESENCE_COLORS = ["#d13415", "#2a7e3b", "#107d98", "#6550b9", "#c2298a", "#cc4e00", "#0d74ce", "#008573"]

export function acquirePostCollab(postId: number): HocuspocusCollaboration {
  if (typeof window === "undefined") throw new Error("Collaboration is client-only")
  return acquireHocuspocus(postId, () => {
    const user = authManager.getState().user
    return new HocuspocusCollaboration(postId, {
      url: hocuspocusUrl(window.location),
      getTicket: async (docName) => (await createCollabTicket(docName)).ticket,
      user: {
        name: user?.full_name || user?.username || "Anonymous",
        color: PRESENCE_COLORS[(user?.id || 0) % PRESENCE_COLORS.length],
        id: user?.id || 0,
      },
    })
  })
}

export const releasePostCollab = releaseHocuspocus
