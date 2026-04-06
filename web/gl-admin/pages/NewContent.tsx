import React from "react"
import { useParams } from "react-router-dom"
import PostForm from "@gl-admin/components/forms/PostForm"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function NewContent() {
  const { typeName } = useParams<{ typeName: string }>()
  return <PostForm mode="create" contentType={typeName || "post"} />
}
