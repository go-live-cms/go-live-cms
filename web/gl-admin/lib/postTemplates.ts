import { ApiError } from "@gl-admin/lib/api/errors"
import type { PostTemplate } from "@gl-admin/lib/api/postTemplates"

// Post templates (#322): the rules and wording the new-post chooser, "Save as
// template" and the templates manager share. The name limits mirror the API's
// postTemplateNameMin/Max (api/post_templates.go; postTemplates.test.ts reads them).

export const TEMPLATE_NAME_MIN = 3
export const TEMPLATE_NAME_MAX = 120

// The API's 409 for a name the post type already has (any case).
export const TEMPLATE_NAME_TAKEN = "template_name_taken"

// What the field shows for a name the API would refuse; null when it's fine.
export function templateNameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Give the template a name."
  if (/[\r\n]/.test(name)) return "Keep the name on one line."
  const length = Array.from(trimmed).length
  if (length < TEMPLATE_NAME_MIN) return `Use at least ${TEMPLATE_NAME_MIN} characters.`
  if (length > TEMPLATE_NAME_MAX) return `Use at most ${TEMPLATE_NAME_MAX} characters.`
  return null
}

// The field error for a failed save or rename, when it's about the name.
export function templateNameConflict(error: unknown, name: string, noun = "post"): string | null {
  if (error instanceof ApiError && error.status === 409 && error.code === TEMPLATE_NAME_TAKEN) {
    return `There's already a ${noun} template named “${name.trim()}”.`
  }
  return null
}

// The line under a template in the chooser: which settings it brings along.
export function templateSummary(template: Pick<PostTemplate, "terms" | "featured_image_id">): string {
  const parts: string[] = []
  if (template.terms.length > 0) {
    parts.push(`${template.terms.length === 1 ? "Category" : "Categories"}: ${template.terms.map((t) => t.name).join(", ")}`)
  }
  if (template.featured_image_id !== null) parts.push("Featured image")
  return parts.length > 0 ? `Content · ${parts.join(" · ")}` : "Content only"
}

// The toasts.
export const savedTemplateMessage = (name: string) => `Saved “${name.trim()}” as a template.`
export const fromTemplateMessage = (name: string) => `New draft from “${name}”. You’re editing it.`
export const deletedTemplateMessage = (name: string) => `Template “${name}” deleted. Posts made from it keep their content.`
