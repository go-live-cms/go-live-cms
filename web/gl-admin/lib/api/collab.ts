import { apiCall } from "../api"

// A short-lived, single-use ticket that opens the collab socket for one document
// (e.g. "post-12"). The socket URL ends up in proxy access logs, so it carries this
// ticket and never the access token (#233).
export async function createCollabTicket(doc: string): Promise<{ ticket: string; expires_at: string }> {
  return apiCall("/collab/tickets", { method: "POST", body: { doc } })
}
