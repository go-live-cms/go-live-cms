import React, { useState, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, getPostById, updatePost } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post, PostType } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import { blockAPIClient, type PostVersion } from "@gl-admin/lib/api/blockAPI"
import { htmlToBlockDoc } from "@gl-admin/lib/utils/htmlToBlocks"
import Editor, { type EditorRef } from "@gl-admin/components/editor/Editor"
import PublishBar from "@gl-admin/components/editor/ui/PublishBarNew"
import PostSidebar from "@gl-admin/components/editor/ui/PostSidebar"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { useCollabPresence } from "@gl-admin/components/editor/utils/useCollabPresence"
import { postEditorAccess, type PermissionUser } from "@gl-admin/lib/roles"
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
  // Bumped after publish/unpublish/restore so the Revisions tab reloads (#136)
  const [revisionsKey, setRevisionsKey] = useState(0)

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
    // From the post right away: the per-post locks below depend on it (#135)
    post_status: (initialData?.post_status as "draft" | "published") || "draft",
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

  // Per-post permissions (#135, mirroring api/auth_posts.go): admins and editors may edit
  // and publish any post; contributors may write their own posts but never publish, and
  // once their post is published only its working copy (the editor body, live after an
  // editor publishes), not its title or settings. Anyone else's post is view-only: the WS
  // server rejects that collab connection and the API rejects the writes, so the editor
  // opens read-only and doesn't connect at all. The user cached at login can be stale
  // (demotion/promotion since), so in edit mode it is re-read from /users/me before the
  // editor mounts. Otherwise a demoted editor would get an editable editor whose socket is
  // rejected in a loop.
  const [me, setMe] = useState<PermissionUser | undefined>(() => authManager.getState().user ?? undefined)
  const [roleVerified, setRoleVerified] = useState(mode !== "edit")
  useEffect(() => {
    if (mode !== "edit") return
    let cancelled = false
    authManager.refreshUser().then((user) => {
      if (cancelled) return
      setMe(user ?? undefined)
      setRoleVerified(true)
    })
    return () => {
      cancelled = true
    }
  }, [mode])

  const access = postEditorAccess(
    me,
    mode,
    mode === "edit" && initialData ? { user_id: initialData.user_id, post_status: formData.post_status } : undefined
  )
  const contentReadOnly = !access.content
  const detailsReadOnly = !access.details
  const canPublish = access.publish
  // A user who can't edit the post still gets the live doc, read-only (the collab server
  // makes that connection read-only).
  const collabEnabled = mode === "edit" && roleVerified

  const { status: collabStatus, users: collabUsers } = useCollabPresence(initialData?.id, collabEnabled)

  // The collab server saves the content only, so the title is saved on its own, debounced,
  // through PUT /posts/:id. Only for users who may change it.
  const savedTitleRef = useRef(initialData?.title ?? "")
  const titleSaveable = mode === "edit" && roleVerified && !detailsReadOnly && !!initialData?.id
  const saveTitle = async (): Promise<void> => {
    const title = formData.title.trim()
    if (!titleSaveable || !initialData?.id || title === savedTitleRef.current || title.length < 3) return
    await updatePost(initialData.id, { title })
    savedTitleRef.current = title
  }
  useEffect(() => {
    if (!titleSaveable) return
    const timer = setTimeout(() => {
      saveTitle().catch((error) => {
        showError("Failed to save the title")
        console.error("Title save failed:", error)
      })
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.title, titleSaveable])

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
      const slug = initialData.slug || urlParts[urlParts.length - 1] || ""
      savedTitleRef.current = initialData.title

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
    // Read-only users can't write; also covers the Ctrl+S shortcut (#216).
    if (contentReadOnly) return
    // Use Block Spec v1 persistence for edit mode, fallback to traditional save for create mode
    if (mode === "edit" && editorRef.current && initialData?.id) {
      try {
        await Promise.all([saveTitle(), editorRef.current.forceSave()])
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
    if (contentReadOnly || !canPublish) return
    // Use Block Spec v1 publishing for edit mode, fallback to traditional publish for create mode
    if (mode === "edit" && editorRef.current && initialData?.id) {
      try {
        await saveTitle()
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

  // Back to draft; the public page 404s and its snapshot is dropped (#136)
  const handleUnpublish = async () => {
    if (!canPublish || !initialData?.id) return
    try {
      const token = authManager.getAccessToken()
      if (token) blockAPIClient.setAuthToken(token)
      await blockAPIClient.unpublishPost(initialData.id)
      setFormData((prev) => ({ ...prev, post_status: "draft" }))
      setRevisionsKey((k) => k + 1)
      showSuccess("Unpublished: the post is a draft again")
    } catch (error) {
      showError("Failed to unpublish")
      console.error("Unpublish failed:", error)
    }
  }

  // Load a version into the working copy through the live editor, so collaborators
  // get it via Yjs. Publishing afterwards makes it live (as a new version).
  const handleRestoreVersion = async (version: PostVersion) => {
    if (contentReadOnly || !canPublish || !editorRef.current) return
    try {
      const { saved } = await editorRef.current.restoreVersion(version.doc)
      showSuccess(
        saved
          ? `Restored version ${version.version_no} to the draft. Publish to make it live.`
          : `Restored version ${version.version_no}; saving…`
      )
      setRevisionsKey((k) => k + 1)
    } catch (error) {
      showError(error instanceof Error ? error.message : "Failed to restore version")
      console.error("Restore failed:", error)
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
        // The body as Block Spec v1, sent with the create.
        const initialBlockDoc = formData.content ? htmlToBlockDoc(formData.content) : null
        const postData: CreatePostRequest = {
          title: formData.title,
          url: fullUrl,
          slug: formData.slug || undefined,
          content: formData.content,
          description: description,
          author_ids: [authState.user.id],
          post_status: isPublish ? "published" : formData.post_status,
          post_type: postType,
          menu_order: 0,
          // The body goes in with the post; the collab server seeds the doc from it on
          // first open.
          ...(initialBlockDoc ? { block_doc: initialBlockDoc } : {}),
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

        // Publishing on create: copy the block_doc sent above to the published snapshot.
        if (isPublish && initialBlockDoc) {
          try {
            const token = authManager.getAccessToken()
            if (token) blockAPIClient.setAuthToken(token)
            await blockAPIClient.publishPost(result.post.id)
          } catch (error) {
            console.error("❌ Failed to publish the initial blocks:", error)
            showError("Warning: Content may not have been published properly")
            // Don't fail the entire operation if publishing the blocks fails
          }
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
          slug: formData.slug || undefined,
          content: formData.content,
          description: description,
          post_status: isPublish ? "published" : formData.post_status,
        }

        const result = await updatePost(initialData.id, updateData)
        // The API normalizes the slug and suffixes it (-2, -3, ...) if another
        // post has it; show what was actually stored.
        if (result?.post?.slug && result.post.slug !== formData.slug) {
          setFormData((prev) => ({ ...prev, slug: result.post.slug }))
        }
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
        readOnly={contentReadOnly}
        canPublish={canPublish}
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
              readOnly={detailsReadOnly}
            />
          </div>

          <div className="post-editor__content">
            {roleVerified && contentReadOnly && (
              <p className="post-editor__readonly-notice" role="status">
                View-only: you can only edit posts you wrote.
              </p>
            )}
            {roleVerified && !contentReadOnly && detailsReadOnly && (
              <p className="post-editor__readonly-notice" role="status">
                This post is published. Your changes are saved as a draft and go live when an
                editor publishes them. The title and settings are locked.
              </p>
            )}
            {/* Mount only once the current role is known, so a stale cached role never
                opens a collab connection the server would reject. */}
            {roleVerified && (
            <Editor
              ref={editorRef}
              readOnly={contentReadOnly}
              value={formData.content}
              title={formData.title}
              minChars={10}
              onChange={(html, text) => {
                setFormData((prev) => ({ ...prev, content: html }))
                setContentTextLen(text.trim().length)
              }}
              placeholder={`Type '/' for commands… Write your ${contentTypeName.toLowerCase()} here.`}
              postId={initialData?.id}
              enableCollaboration={collabEnabled} // Edit mode, for users who may edit this post
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
                // A save can be refused because an editor published the post meanwhile,
                // which locks its title for a contributor (#135). Re-read the status and
                // title so the locks catch up and later saves stop sending the refused title.
                if (!canPublish && initialData?.id) {
                  getPostById(initialData.id)
                    .then(({ post }) =>
                      setFormData((prev) =>
                        post.post_status === prev.post_status
                          ? prev
                          : { ...prev, post_status: post.post_status as "draft" | "published", title: post.title }
                      )
                    )
                    .catch(() => {})
                }
              }}
              onPublishStart={() => {
                setIsSubmitting(true)
              }}
              onPublishSuccess={(result) => {
                setIsSubmitting(false)
                setFormData((prev) => ({ ...prev, post_status: "published" }))
                setRevisionsKey((k) => k + 1)
              }}
              onPublishError={(error) => {
                setIsSubmitting(false)
                showError("Publish failed")
              }}
            />
            )}
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
        readOnly={detailsReadOnly}
        canPublish={canPublish}
        onUnpublish={collabEnabled && canPublish ? handleUnpublish : undefined}
        onRestoreVersion={collabEnabled && canPublish ? handleRestoreVersion : undefined}
        revisionsKey={revisionsKey}
      />

      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  )
}
