import React from "react"
import PostForm from "@gl-admin/components/forms/PostForm"
import { editorHeading } from "@gl-admin/lib/editorHeading"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function NewPost() {
  const heading = editorHeading("create", "post")
  usePageTitle(heading)
  return (
    <>
      {/* The editor's title is a field, not a heading (#480). */}
      <h1 className="gl-visually-hidden">{heading}</h1>
      <PostForm mode="create" />
    </>
  )
}
