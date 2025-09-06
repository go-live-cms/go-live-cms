import React, { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, updatePost } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post, PostType } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import Editor from "@gl-admin/components/editor/Editor"
import PublishBar from "@gl-admin/components/editor/PublishBarNew"
import PostSidebar from "@gl-admin/components/editor/PostSidebar"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"
import "@gl-admin/assets/styles/components/Toast.scss"

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
  const { toasts, showSuccess, showError, removeToast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error" | null>(null)

  const ORIGINAL_SIDEBAR_WIDTH = 20 * 16
  const MIN_SIDEBAR_WIDTH = ORIGINAL_SIDEBAR_WIDTH * 0.8
  const MAX_SIDEBAR_WIDTH = ORIGINAL_SIDEBAR_WIDTH * 1.5
  const initialSidebarWidth = parseInt(localStorage.getItem("postSettingsSidebarWidth") || "") || ORIGINAL_SIDEBAR_WIDTH
  const [sidebarWidth, setSidebarWidth] = useState(`${initialSidebarWidth}px`)
  const [sidebarVisible, setSidebarVisible] = useState(
    localStorage.getItem("postSettingsSidebarState") === "true" || false
  )
  const [contentTextLen, setContentTextLen] = useState(0)

  const [formData, setFormData] = useState<PostFormData>({
    title: "",
    slug: "",
    content: "",
    excerpt: "",
    post_status: "draft",
  })

  let mockPostType: PostType

  const currentPost: Post = {
    id: initialData?.id || 0,
    title: formData.title,
    description: formData.excerpt,
    content: formData.content,
    user_id: initialData?.user_id || 0,
    username: initialData?.username || "",
    post_type: contentType || initialData?.post_type || "post",
    post_status: formData.post_status,
    url: formData.slug,
    menu_order: initialData?.menu_order || 0,
    created_at: initialData?.created_at || new Date().toISOString(),
    changed_at: initialData?.changed_at || new Date().toISOString(),
  }

  const handlePostUpdate = (updates: Partial<Post>) => {
    setFormData((prev) => ({
      ...prev,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.description !== undefined && { excerpt: updates.description }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.post_status !== undefined && { post_status: updates.post_status as "draft" | "published" }),
      ...(updates.url !== undefined && { slug: updates.url }),
    }))
  }
  const handleSlugChange = (newSlug: string) => {
    setFormData((prev) => ({ ...prev, slug: newSlug }))
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault()
        handleSave()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [formData])

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

  useEffect(() => {
    localStorage.setItem("postSettingsSidebarWidth", sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem("postSettingsSidebarState", sidebarVisible.toString())
  }, [sidebarVisible])

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

  mockPostType = {
    id: 1,
    name: contentType || "post",
    label: getContentTypeName(contentType),
    description: "",
    hierarchical: false,
    public: true,
    show_ui: true,
    show_in_menu: true,
    created_at: new Date().toISOString(),
  }

  const handleSidebarResize = (e: React.MouseEvent) => {
    const resizing = { current: true }
    document.body.style.cursor = "ew-resize"

    const startX = e.clientX
    const startWidth = parseInt(sidebarWidth)

    let animationFrameId: number | null = null

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!resizing.current) return

      if (animationFrameId) return

      animationFrameId = window.requestAnimationFrame(() => {
        let newWidth = startWidth - (moveEvent.clientX - startX)
        newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth))
        setSidebarWidth(`${newWidth}px`)
        animationFrameId = null
      })
    }

    const onMouseUp = () => {
      resizing.current = false
      document.body.style.cursor = ""
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
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

  const handleSave = async () => {
    await savePost(false)
  }

  const savePost = async (isPublish: boolean = false) => {
    const setSavingState = isPublish ? setIsSubmitting : setIsSaving
    const setSaveStatusState = isPublish ? () => {} : setSaveStatus

    setSavingState(true)
    setSaveStatusState("saving")

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
          post_status: isPublish ? "published" : formData.post_status,
          post_type: postType,
          menu_order: 0,
        }

        const result = await createPost(postData)
        const successMessage = `${getContentTypeName(postType)} ${isPublish ? "published" : "saved"} successfully!`
        showSuccess(successMessage)
        setSaveStatusState("saved")

        if (onSuccess) {
          onSuccess(result.post)
        }

        // Redirect to edit page after creation
        if (isPublish) {
          setTimeout(() => {
            navigate(`/content/edit/${result.post.id}`)
          }, 1000)
        } else {
          navigate(`/content/edit/${result.post.id}`)
        }
      } else if (mode === "edit" && initialData) {
        const updateData = {
          title: formData.title,
          url: fullUrl,
          content: formData.content,
          description: description,
          post_status: isPublish ? "published" : formData.post_status,
        }

        const result = await updatePost(initialData.id, updateData)
        const successMessage = `${getContentTypeName()} ${isPublish ? "published" : "saved"} successfully!`
        showSuccess(successMessage)
        setSaveStatusState("saved")

        if (onSuccess) {
          onSuccess(result.post)
        }
      }
    } catch (error) {
      console.error(`Error ${mode === "create" ? "creating" : "updating"} content:`, error)
      const contentTypeName = getContentTypeName().toLowerCase()
      const errorMessage =
        error instanceof Error ? error.message : `Failed to ${mode} ${contentTypeName}. Please try again.`
      showError(errorMessage)
      setSaveStatusState("error")

      if (onError) {
        onError(errorMessage)
      }
    } finally {
      setSavingState(false)

      if (!isPublish) {
        setTimeout(() => {
          setSaveStatus(null)
        }, 3000)
      }
    }
  }

  const contentTypeName = getContentTypeName()

  return (
    <div className="post-editor">
      <PublishBar
        post={currentPost}
        onSave={handleSave}
        onPublish={() => savePost(true)}
        isSaving={isSaving}
        isPublishing={isSubmitting}
        saveStatus={saveStatus}
        onSettingsToggle={() => setSidebarVisible(!sidebarVisible)}
      />

      <div
        className={`post-editor__container ${sidebarVisible ? "post-editor__container--with-sidebar" : ""}`}
        style={sidebarVisible ? ({ "--post-settings-width": sidebarWidth } as React.CSSProperties) : {}}
      >
        <div className="post-editor__main">
          <div className="post-editor__title">
            <input
              type="text"
              placeholder="Add title"
              value={formData.title}
              onChange={handleTitleChange}
              className="post-editor__title-input"
              id="post-title"
              name="post-title"
            />
          </div>

          <div className="post-editor__content">
            <Editor
              value={formData.content}
              minChars={10}
              onChange={(html, text) => {
                setFormData((prev) => ({ ...prev, content: html }))
                setContentTextLen(text.trim().length)
              }}
              placeholder={`Type '/' for commands… Write your ${contentTypeName.toLowerCase()} here.`}
            />
          </div>
        </div>
      </div>

      <PostSidebar
        post={currentPost}
        postType={mockPostType}
        onUpdate={handlePostUpdate}
        isVisible={sidebarVisible}
        onToggle={() => setSidebarVisible(!sidebarVisible)}
        sidebarWidth={sidebarWidth}
        onResize={handleSidebarResize}
        slug={formData.slug}
        mode={mode}
        onSlugChange={handleSlugChange}
      />

      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  )
}
