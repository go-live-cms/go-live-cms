import { apiCall } from "../api"

// The markup of custom HTML blocks (#428). Reading follows the post (the locked preview);
// writing is admins only, on the server. `html` in an answer is what the API kept after
// sanitizing, never what was sent.

export interface HtmlSnippet {
  id: string
  html: string
}

export async function listHtmlSnippets(postId: number): Promise<HtmlSnippet[]> {
  const out = (await apiCall(`/posts/${postId}/html-snippets`)) as { snippets: HtmlSnippet[] }
  return out.snippets
}

export async function createHtmlSnippet(postId: number, html: string): Promise<HtmlSnippet> {
  const out = (await apiCall(`/posts/${postId}/html-snippets`, { method: "POST", body: JSON.stringify({ html }) })) as { snippet: HtmlSnippet }
  return out.snippet
}

export async function updateHtmlSnippet(postId: number, id: string, html: string): Promise<HtmlSnippet> {
  const out = (await apiCall(`/posts/${postId}/html-snippets/${id}`, { method: "PUT", body: JSON.stringify({ html }) })) as { snippet: HtmlSnippet }
  return out.snippet
}
