import React, { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { getPostById } from "@gl-admin/lib/api/posts"
import type { Post } from "@gl-admin/lib/api/types"
import PostForm from "@gl-admin/components/forms/PostForm"
import { editorHeading } from "@gl-admin/lib/editorHeading"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function EditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [post, setPost] = useState<Post | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const heading = editorHeading("edit", "page", post?.title)
  usePageTitle(post ? heading : loading ? "Loading…" : error ? "Error" : "Page not found")

  useEffect(() => {
    const fetchPost = async () => {
      if (!id) {
        setError("No page ID provided")
        setLoading(false)
        return
      }

      try {
        const response = await getPostById(id)
        setPost(response.post)
      } catch (err) {
        console.error("Error fetching page:", err)
        setError("Failed to load page")
      } finally {
        setLoading(false)
      }
    }

    fetchPost()
  }, [id])

  const handleSuccess = (updatedPost: Post) => {
    setPost(updatedPost)
  }

  const handleError = (errorMessage: string) => {
    setError(errorMessage)
  }

  if (loading) {
    return (
      <div className="post-form-page">
        <div className="page-header">
          <h1>Loading Page...</h1>
        </div>
        <div>Loading page data...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="post-form-page">
        <div className="page-header">
          <h1>Error</h1>
        </div>
        <div className="message error">{error}</div>
        <button onClick={() => navigate("/content/page")} className="btn btn-secondary">
          Back to Pages
        </button>
      </div>
    )
  }

  if (!post) {
    return (
      <div className="post-form-page">
        <div className="page-header">
          <h1>Page Not Found</h1>
        </div>
        <div className="message error">The requested page could not be found.</div>
        <button onClick={() => navigate("/content/page")} className="btn btn-secondary">
          Back to Pages
        </button>
      </div>
    )
  }

  return (
    <>
      {/* The editor's title is a field, not a heading (#480). */}
      <h1 className="gl-visually-hidden">{heading}</h1>
      <PostForm mode="edit" initialData={post} onSuccess={handleSuccess} onError={handleError} />
    </>
  )
}
