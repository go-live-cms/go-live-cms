import { apiCall } from "../api"

// The design preview (#486, docs/design/theme-builder.md 8.3), for the Site editor's
// preview frame (#487). The token never goes in a URL: it is posted to /gl-preview, which
// keeps it in an HttpOnly cookie and redirects the frame to the page.

export interface DesignPreview {
  token: string
  theme: string
  expires_at: string
}

/** A preview token for the caller (admins only) and the active theme, 15 minutes. */
export async function createDesignPreview(): Promise<DesignPreview> {
  return apiCall("/site-design/preview", { method: "POST" })
}

/**
 * Starts a preview of `path` (a path on this site, e.g. "/" or "/category/guides") in the
 * window or frame named `target`: a fresh token, posted by a hidden form, so it is in the
 * request body only. Call it again to reload the preview with a new token (the old one
 * keeps working until it expires).
 */
export async function openDesignPreview(target: string, path: string, doc: Document = document): Promise<DesignPreview> {
  const preview = await createDesignPreview()
  const form = doc.createElement("form")
  form.method = "post"
  form.action = "/gl-preview"
  form.target = target
  form.hidden = true
  for (const [name, value] of [["token", preview.token], ["redirect", path]]) {
    const input = doc.createElement("input")
    input.type = "hidden"
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  doc.body.appendChild(form)
  try {
    form.submit()
  } finally {
    form.remove()
  }
  return preview
}
