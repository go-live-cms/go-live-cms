import React, { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { getPostById } from "@gl-admin/lib/api/posts"
import type { Post } from "@gl-admin/lib/api/types"
import PostForm from "@gl-admin/components/forms/PostForm"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

export default function EditContent() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [post, setPost] = useState<Post | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchPost = async () => {
      if (!id) {
        setError("No content ID provided")
        setLoading(false)
        return
      }

      try {
        const response = await getPostById(id)
        setPost(response.post)
      } catch (err) {
        console.error("Error fetching content:", err)
        setError("Failed to load content")
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

  const getContentTypeName = (postType: string) => {
    return postType.charAt(0).toUpperCase() + postType.slice(1)
  }

  const getBackUrl = (postType: string) => {
    return `/content/${postType}`
  }

  if (loading) {
    return (
      <div className="post-form-page">
        <div className="page-header">
          <h1>Loading Content...</h1>
        </div>
        <div>Loading content data...</div>
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
        <button onClick={() => navigate("/content")} className="btn btn-secondary">
          Back to Content
        </button>
      </div>
    )
  }

  if (!post) {
    return (
      <div className="post-form-page">
        <div className="page-header">
          <h1>Content Not Found</h1>
        </div>
        <div className="message error">The requested content could not be found.</div>
        <button onClick={() => navigate("/content")} className="btn btn-secondary">
          Back to Content
        </button>
      </div>
    )
  }

  return (
    <PostForm
      mode="edit"
      initialData={post}
      onSuccess={handleSuccess}
      onError={handleError}
      contentType={post.post_type}
    />
  )
}
