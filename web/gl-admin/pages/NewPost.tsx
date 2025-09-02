import React, { useState } from "react"
import { createPost } from "@gl-admin/lib/api/posts"
import Input from "@gl-admin/components/ui/Input"
import "@gl-admin/assets/styles/pages/new-post.scss"
import Button from "@gl-admin/components/ui/Button"
import { authManager } from "@gl-admin/lib/auth"

interface NewPostForm {
  title: string
  slug: string
  content: string
  excerpt: string
  post_status: "draft" | "published"
}

export default function NewPost() {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const [formData, setFormData] = useState<NewPostForm>({
    title: "",
    slug: "",
    content: "",
    excerpt: "",
    post_status: "draft",
  })

  // Auto-generate slug from title
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
      slug: prev.slug === "" || prev.slug === generateSlug(prev.title) ? generateSlug(title) : prev.slug,
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
      // Get current user from auth state
      const authState = authManager.getState()
      if (!authState.user) {
        throw new Error("User not authenticated")
      }

      // Ensure description meets minimum length requirement
      const description = formData.excerpt.trim() || formData.title
      if (description.length < 10) {
        throw new Error("Description must be at least 10 characters long")
      }

      // Convert slug to full URL format
      const baseUrl = window.location.origin
      const fullUrl = `${baseUrl}/posts/${formData.slug}`

      const postData = {
        title: formData.title,
        url: fullUrl,
        content: formData.content,
        description: description,
        author_ids: [authState.user.id], // Use current user's ID
        post_status: formData.post_status,
      }

      console.log("Sending post data:", postData) // Debug log

      await createPost(postData)

      setMessage({ type: "success", text: "Post created successfully!" })

      // Reset form
      setFormData({
        title: "",
        slug: "",
        content: "",
        excerpt: "",
        post_status: "draft",
      })
    } catch (error) {
      console.error("Error creating post:", error)
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to create post. Please try again.",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="new-post-page">
      <div className="page-header">
        <h1>Add New Post</h1>
      </div>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      <form onSubmit={handleSubmit} className="new-post-form">
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
            {isSubmitting ? "Creating..." : "Create Post"}
          </Button>
        </div>
      </form>
    </div>
  )
}
