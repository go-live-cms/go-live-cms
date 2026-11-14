// The post editor's page heading and tab title (#480): the editor shows the title as
// a field, not a heading, so EditPost / NewContent render this as a visually hidden
// <h1> ("Edit post: Spring launch"), which route changes focus and headings lists show.
export function editorHeading(mode: "create" | "edit", postType: string | undefined, title?: string | null): string {
  const type = (postType || "post").trim() || "post"
  if (mode === "create") return `New ${type}`
  return `Edit ${type}: ${title?.trim() || "Untitled"}`
}
