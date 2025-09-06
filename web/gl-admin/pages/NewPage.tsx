import React from "react"
import PostForm from "@gl-admin/components/forms/PostForm"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function NewPage() {
  return <PostForm mode="create" contentType="page" />
}
