import React from "react"
import { useParams } from "react-router-dom"
import PostForm from "@gl-admin/components/forms/PostForm"
import { editorHeading } from "@gl-admin/lib/editorHeading"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function NewContent() {
  const { typeName } = useParams<{ typeName: string }>()
  const heading = editorHeading("create", typeName)
  usePageTitle(heading)
  return (
    <>
      {/* The editor's title is a field, not a heading (#480). */}
      <h1 className="gl-visually-hidden">{heading}</h1>
      <PostForm mode="create" contentType={typeName || "post"} />
    </>
  )
}
