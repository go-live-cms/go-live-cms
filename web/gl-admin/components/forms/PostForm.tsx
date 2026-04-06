import React, { useState, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, updatePost } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post, PostType } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { htmlToBlockDoc } from "@gl-admin/lib/utils/htmlToBlocks"
import Editor, { type EditorRef } from "@gl-admin/components/editor/Editor"
import PublishBar from "@gl-admin/components/editor/ui/PublishBarNew"
import PostSidebar from "@gl-admin/components/editor/ui/PostSidebar"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { useCollabPresence } from "@gl-admin/components/editor/utils/useCollabPresence"
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
  const editorRef = useRef<EditorRef>(null)

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
    user_id: initialData?.user_id || 0,
    username: initialData?.username || "",
    post_type: contentType || initialData?.post_type || "post",
    post_status: formData.post_status,
    url: formData.slug,
    menu_order: initialData?.menu_order || 0,
    created_at: initialData?.created_at || new Date().toISOString(),
    changed_at: initialData?.changed_at || new Date().toISOString(),
  }

  const { status: collabStatus, users: collabUsers } = useCollabPresence(initialData?.id, mode === "edit")

  const handlePostUpdate = (updates: Partial<Post>) => {
    setFormData((prev) => ({
      ...prev,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.description !== undefined && { excerpt: updates.description }),
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
        content: "",
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
    return postType.charAt(0).toUpperCase() + postType.slice(1)
  }

  const getBackUrl = (type?: string) => {
    const postType = type || contentType || initialData?.post_type || "post"
    return `/content/${postType}`
  }

  mockPostType = {
    id: 1,
    name: contentType || "post",
    label: getContentTypeName(contentType),
    description: "",
    hierarchical: false,
    public: true,
    has_archive: true,
    menu_position: null,
    supports: ["title", "content", "description"],
    is_active: true,
    registered_by: "system",
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
    // Use Block Spec v1 persistence for edit mode, fallback to traditional save for create mode
    if (mode === "edit" && editorRef.current && initialData?.id) {
      try {
        await editorRef.current.forceSave()
        showSuccess("Changes saved successfully")
      } catch (error) {
        showError("Failed to save changes")
        console.error("Block save failed:", error)
      }
    } else {
      await savePost(false)
    }
  }

  const handlePublish = async () => {
    // Use Block Spec v1 publishing for edit mode, fallback to traditional publish for create mode
    if (mode === "edit" && editorRef.current && initialData?.id) {
      try {
        const result = await editorRef.current.publish()
        if (result) {
          showSuccess(`Published as version ${result.versionNo}`)
          // Update the post status in the form data
          setFormData((prev) => ({ ...prev, post_status: "published" }))
        }
      } catch (error) {
        showError("Failed to publish")
        console.error("Block publish failed:", error)
      }
    } else {
      await savePost(true)
    }
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
      const postType = contentType || "post"
      const fullUrl = `${baseUrl}/${postType}/${formData.slug}`

      if (mode === "create") {
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

        console.log("📝 Post created successfully:", {
          postId: result.post.id,
          title: result.post.title,
          hasContent: !!formData.content,
          contentLength: formData.content?.length || 0,
          contentPreview: formData.content?.substring(0, 100),
        })

        // Convert HTML content to blocks and save immediately
        if (formData.content) {
          try {
            console.log("🔄 Converting HTML to blocks...")
            const blockDoc = htmlToBlockDoc(formData.content)
            console.log("✅ Blocks generated:", {
              blocksCount: Object.keys(blockDoc.blocks).length,
              blocksOrder: blockDoc.blocks_order.length,
              blockDoc,
            })

            const token = authManager.getAccessToken()
            if (token) {
              blockAPIClient.setAuthToken(token)
              console.log("💾 Saving blocks to post", result.post.id)
              const saveResult = await blockAPIClient.updatePostBlocks(result.post.id, blockDoc, 1)
              console.log("✅ Blocks saved successfully to block_doc:", saveResult)

              // If published, also publish the blocks (copies block_doc → published_block_doc)
              if (isPublish) {
                console.log("📤 Publishing blocks (copying to published_block_doc)...")
                const publishResult = await blockAPIClient.publishPost(result.post.id)
                console.log("✅ Blocks published:", publishResult)
              }
            } else {
              console.error("❌ No auth token available for saving blocks")
            }
          } catch (error) {
            console.error("❌ Failed to save initial blocks:", error)
            showError("Warning: Content may not have been saved properly")
            // Don't fail the entire operation if block save fails
          }
        } else {
          console.warn("⚠️ No content to save - formData.content is empty")
        }

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
        onPublish={handlePublish}
        isSaving={isSaving}
        isPublishing={isSubmitting}
        saveStatus={saveStatus}
        onSettingsToggle={() => setSidebarVisible(!sidebarVisible)}
        collabStatus={collabStatus}
        collabUsers={collabUsers}
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
              ref={editorRef}
              value={formData.content}
              title={formData.title}
              minChars={10}
              onChange={(html, text) => {
                setFormData((prev) => ({ ...prev, content: html }))
                setContentTextLen(text.trim().length)
              }}
              placeholder={`Type '/' for commands… Write your ${contentTypeName.toLowerCase()} here.`}
              postId={initialData?.id}
              enableCollaboration={mode === "edit"} // Only enable collaboration in edit mode
              // Block Spec v1 persistence callbacks
              onSaveStart={() => {
                setIsSaving(true)
                setSaveStatus("saving")
              }}
              onSaveSuccess={(revision) => {
                setIsSaving(false)
                setSaveStatus("saved")
              }}
              onSaveError={(error) => {
                setIsSaving(false)
                setSaveStatus("error")
                showError("Auto-save failed")
              }}
              onPublishStart={() => {
                setIsSubmitting(true)
              }}
              onPublishSuccess={(result) => {
                setIsSubmitting(false)
                setFormData((prev) => ({ ...prev, post_status: "published" }))
              }}
              onPublishError={(error) => {
                setIsSubmitting(false)
                showError("Publish failed")
              }}
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
