import React, { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, updatePost } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post } from "@gl-admin/lib/api/types"
import Input from "@gl-admin/components/ui/Input"
import Button from "@gl-admin/components/ui/Button"
import { authManager } from "@gl-admin/lib/auth"

interface PostFormData {
  title: string
  slug: string
  content: string
  excerpt: string
  post_status: "draft" | "published"
}

interface PostFormProps {
  mode: "create" | "edit"
  initialData?: Post
  onSuccess?: (post: Post) => void
  onError?: (error: string) => void
}

export default function PostForm({ mode, initialData, onSuccess, onError }: PostFormProps) {
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const [formData, setFormData] = useState<PostFormData>({
    title: "",
    slug: "",
    content: "",
    excerpt: "",
    post_status: "draft",
  })

  // Initialize form data with existing post data if in edit mode
  useEffect(() => {
    if (mode === "edit" && initialData) {
      const urlParts = initialData.url.split("/")
      const slug = urlParts[urlParts.length - 1] || ""

      setFormData({
        title: initialData.title,
        slug: slug,
        content: initialData.content,
        excerpt: initialData.description,
        post_status: initialData.post_status as "draft" | "published",
      })
    }
  }, [mode, initialData])

  const generateSlug = (title: string) => {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim()
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const title = e.target.value
    setFormData((prev) => ({
      ...prev,
      title,
      // Only auto-generate slug for new posts or if slug hasn't been manually edited
      slug:
        mode === "create" && (prev.slug === "" || prev.slug === generateSlug(prev.title))
          ? generateSlug(title)
          : prev.slug,
    }))
  }

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, slug: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setMessage(null)

    try {
      const authState = authManager.getState()
      if (!authState.user) {
        throw new Error("User not authenticated")
      }

      const description = formData.excerpt.trim() || formData.title
      if (description.length < 10) {
        throw new Error("Description must be at least 10 characters long")
      }

      const baseUrl = window.location.origin
      const fullUrl = `${baseUrl}/posts/${formData.slug}`

      if (mode === "create") {
        const postData: CreatePostRequest = {
          title: formData.title,
          url: fullUrl,
          content: formData.content,
          description: description,
          author_ids: [authState.user.id],
          post_status: formData.post_status,
          post_type: "post",
          menu_order: 0,
        }

        const result = await createPost(postData)
        setMessage({ type: "success", text: "Post created successfully!" })

        if (onSuccess) {
          onSuccess(result.post)
        }

        // Redirect to edit page after creation
        setTimeout(() => {
          navigate(`/content/posts/edit/${result.post.id}`)
        }, 1000)
      } else if (mode === "edit" && initialData) {
        const updateData = {
          title: formData.title,
          url: fullUrl,
          content: formData.content,
          description: description,
          post_status: formData.post_status,
        }

        const result = await updatePost(initialData.id, updateData)
        setMessage({ type: "success", text: "Post updated successfully!" })

        if (onSuccess) {
          onSuccess(result.post)
        }
      }
    } catch (error) {
      console.error(`Error ${mode === "create" ? "creating" : "updating"} post:`, error)
      const errorMessage = error instanceof Error ? error.message : `Failed to ${mode} post. Please try again.`
      setMessage({ type: "error", text: errorMessage })

      if (onError) {
        onError(errorMessage)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const pageTitle = mode === "create" ? "Add New Post" : `Edit Post: ${initialData?.title || ""}`

  return (
    <div className="post-form-page">
      <div className="page-header">
        <h1>{pageTitle}</h1>
      </div>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      <form onSubmit={handleSubmit} className="post-form">
        <div className="form-group">
          <Input title="Title *" name="title" value={formData.title} onChange={handleTitleChange} required />
        </div>

        <div className="form-group">
          <Input title="Slug *" name="slug" value={formData.slug} onChange={handleSlugChange} required />
          <small>
            Will be converted to: {window.location.origin}/posts/{formData.slug}
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            value={formData.post_status}
            onChange={(e) => setFormData((prev) => ({ ...prev, post_status: e.target.value as "draft" | "published" }))}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="excerpt">Excerpt *</label>
          <textarea
            id="excerpt"
            value={formData.excerpt}
            onChange={(e) => setFormData((prev) => ({ ...prev, excerpt: e.target.value }))}
            placeholder="Brief description (minimum 10 characters)"
            rows={3}
            required
          />
          <small>
            {formData.excerpt.length}/10 characters minimum
            {formData.excerpt.length < 10 && formData.excerpt.length > 0 && (
              <span style={{ color: "red" }}> - Too short</span>
            )}
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="content">Content *</label>
          <textarea
            id="content"
            value={formData.content}
            onChange={(e) => setFormData((prev) => ({ ...prev, content: e.target.value }))}
            required
            placeholder="Write your post content here... (minimum 10 characters)"
            rows={15}
          />
          <small>
            {formData.content.length}/10 characters minimum
            {formData.content.length < 10 && formData.content.length > 0 && (
              <span style={{ color: "red" }}> - Too short</span>
            )}
          </small>
        </div>

        <div className="form-actions">
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              !formData.title ||
              !formData.slug ||
              !formData.content ||
              formData.content.length < 10 ||
              (formData.excerpt.length > 0 && formData.excerpt.length < 10)
            }
            className="btn btn-primary"
          >
            {isSubmitting
              ? mode === "create"
                ? "Creating..."
                : "Updating..."
              : mode === "create"
              ? "Create Post"
              : "Update Post"}
          </Button>

          {mode === "edit" && (
            <Button type="button" onClick={() => navigate("/content/posts")} className="btn btn-secondary">
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
