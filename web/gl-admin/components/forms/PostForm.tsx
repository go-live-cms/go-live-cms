import React, { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, updatePost } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post } from "@gl-admin/lib/api/types"
import Input from "@gl-admin/components/ui/Input"
import Button from "@gl-admin/components/ui/Button"
import { authManager } from "@gl-admin/lib/auth"
import NotionEditor from "@gl-admin/components/editor/Editor"
import PostType from "../ui/PostType"

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
  contentType?: string
}

export default function PostForm({ mode, initialData, onSuccess, onError, contentType }: PostFormProps) {
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [contentTextLen, setContentTextLen] = useState(0)

  const [formData, setFormData] = useState<PostFormData>({
    title: "",
    slug: "",
    content: "",
    excerpt: "",
    post_status: "draft",
  })

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

  // TODO: these are basically the same, fix it
  const getContentTypeName = (type?: string) => {
    const postType = type || contentType || initialData?.post_type || "post"
    switch (postType) {
      case "post":
        return "Post"
      case "page":
        return "Page"
      default:
        return "Content"
    }
  }

  const getBackUrl = (type?: string) => {
    const postType = type || contentType || initialData?.post_type || "post"
    switch (postType) {
      case "post":
        return "/content/posts"
      case "page":
        return "/content/pages"
      default:
        return "/content"
    }
  }

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
        const postType = contentType || "post"
        const postData: CreatePostRequest = {
          title: formData.title,
          url: fullUrl,
          content: formData.content,
          description: description,
          author_ids: [authState.user.id],
          post_status: formData.post_status,
          post_type: postType,
          menu_order: 0,
        }

        const result = await createPost(postData)
        const successMessage = `${getContentTypeName(postType)} created successfully!`
        setMessage({ type: "success", text: successMessage })

        if (onSuccess) {
          onSuccess(result.post)
        }

        // Redirect to edit page after creation
        setTimeout(() => {
          navigate(`/content/edit/${result.post.id}`)
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
        const successMessage = `${getContentTypeName()} updated successfully!`
        setMessage({ type: "success", text: successMessage })

        if (onSuccess) {
          onSuccess(result.post)
        }
      }
    } catch (error) {
      console.error(`Error ${mode === "create" ? "creating" : "updating"} content:`, error)
      const contentTypeName = getContentTypeName().toLowerCase()
      const errorMessage =
        error instanceof Error ? error.message : `Failed to ${mode} ${contentTypeName}. Please try again.`
      setMessage({ type: "error", text: errorMessage })

      if (onError) {
        onError(errorMessage)
      }
    } finally {
      setIsSubmitting(false)
    }
  }
  const tempFrontendUrl = (post: Post) => {
    return `/${post.post_type}/${post.id}`
  }

  const pageTitle =
    mode === "create" ? `Add New ${getContentTypeName()}` : `Edit ${getContentTypeName()}: ${initialData?.title || ""}`

  const contentTypeName = getContentTypeName()

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
          {mode === "edit" && (
            <small>
              Current URL:
              <a href={initialData && tempFrontendUrl(initialData)}>
                {window.location.origin}
                {initialData && tempFrontendUrl(initialData)}
              </a>
            </small>
          )}
          <small>
            in the future Will be converted to: {window.location.origin}/{getContentTypeName()}/{formData.slug}
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
          <label>Content *</label>
          <NotionEditor
            value={formData.content}
            minChars={10}
            onChange={(html, text) => {
              setFormData((prev) => ({ ...prev, content: html }))
              setContentTextLen(text.trim().length)
            }}
            placeholder={`Type ‘/’ for commands… Write your ${contentTypeName.toLowerCase()} here.`}
          />
          <small>
            {contentTextLen}/10 characters minimum
            {contentTextLen > 0 && contentTextLen < 10 && <span style={{ color: "red" }}> - Too short</span>}
          </small>
        </div>

        <div className="form-actions">
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              !formData.title ||
              !formData.slug ||
              contentTextLen < 10 ||
              (formData.excerpt.length > 0 && formData.excerpt.length < 10)
            }
            className="btn btn-primary"
          >
            {isSubmitting
              ? mode === "create"
                ? "Creating..."
                : "Updating..."
              : mode === "create"
              ? `Create ${contentTypeName}`
              : `Update ${contentTypeName}`}
          </Button>

          {mode === "edit" && (
            <Button type="button" onClick={() => navigate(getBackUrl())} className="btn btn-secondary">
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
