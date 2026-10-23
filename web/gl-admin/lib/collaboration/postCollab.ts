import { authManager } from "../auth"
import { createCollabTicket } from "../api/collab"
import { hocuspocusUrl } from "./backend"
import { acquireHocuspocus, HocuspocusCollaboration, releaseHocuspocus } from "./HocuspocusCollaboration"

// The app's Hocuspocus connection for a post (PUBLIC_COLLAB_BACKEND=hocuspocus): the
// server URL for this page, tickets from POST /collab/tickets, the signed-in user's
// cursor label. HocuspocusCollaboration itself takes these as options so tests can
// point it at an in-process server.

const COLORS = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F"]

export function acquirePostCollab(postId: number): HocuspocusCollaboration {
  if (typeof window === "undefined") throw new Error("Collaboration is client-only")
  return acquireHocuspocus(postId, () => {
    const user = authManager.getState().user
    return new HocuspocusCollaboration(postId, {
      url: hocuspocusUrl(window.location),
      getTicket: async (docName) => (await createCollabTicket(docName)).ticket,
      user: {
        name: user?.full_name || user?.username || "Anonymous",
        color: COLORS[(user?.id || 0) % COLORS.length],
        id: user?.id || 0,
      },
    })
  })
}

export const releasePostCollab = releaseHocuspocus
