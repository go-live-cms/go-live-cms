import React, { useState, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { createPost, getPostById, updatePost, updatePostSEO } from "@gl-admin/lib/api/posts"
import type { CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post, PostSEOSettings } from "@gl-admin/lib/api/types"
import { firstParagraphFromHtml, sameSeo, seoFromPost, seoPayload, seoSaveable } from "@gl-admin/lib/postSeo"
import { firstParagraphText, postPath } from "@/lib/seo"
import { authManager } from "@gl-admin/lib/auth"
import { blockAPIClient, type PostVersion } from "@gl-admin/lib/api/blockAPI"
import { getSettings } from "@gl-admin/lib/api/settings"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { CollabStoreError } from "@gl-admin/lib/collaboration/CollabSaveStatus"
import Editor, { type EditorRef } from "@gl-admin/components/editor/Editor"
import EditorTopBar, { ArchiveIcon, OfflineIcon } from "@gl-admin/components/editor/ui/EditorTopBar"
import PostSidebar from "@gl-admin/components/editor/ui/PostSidebar"
import { VersionPreview, versionTime } from "@gl-admin/components/editor/ui/RevisionsPanel"
import Notice from "@gl-admin/components/ui/Notice"
import Button from "@gl-admin/components/ui/Button"
import Modal from "@gl-admin/components/ui/Modal"
import { AvatarStack } from "@gl-admin/components/ui/Avatar"
import { toast } from "@gl-admin/components/ui/Toast"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { useCollabPresence } from "@gl-admin/components/editor/utils/useCollabPresence"
import {
  shouldWarnBeforeUnload,
  useBeforeUnloadWarning,
  useConnectionView,
} from "@gl-admin/components/editor/utils/connectionState"
import { postEditorAccess, type PermissionUser } from "@gl-admin/lib/roles"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

// A failed publish (#341, "Publish failed"): the banner offers Try again, and after a
// second failure "Copy error details" for support.
type PublishFailure = { attempts: number; message: string; requestId: string | null; storeFailed: boolean }

interface PostFormData {
  title: string
  slug: string
  content: string
  excerpt: string
  post_status: "draft" | "published" | "archived"
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
    post_status: (initialData?.post_status as PostFormData["post_status"]) || "draft",
  })

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

  const { status: collabStatus, users: collabUsers, unsynced } = useCollabPresence(initialData?.id, collabEnabled)
  const connection = useConnectionView(collabStatus, collabEnabled)
  // Nothing is stored on the device (rule 0): while edits are unsynced or the connection
  // is down, this tab holds the only copy of them.
  useBeforeUnloadWarning(
    shouldWarnBeforeUnload({
      editable: collabEnabled && !contentReadOnly,
      unsynced,
      offline: connection === "offline" || connection === "reconnecting",
    })
  )

  const [publishFailure, setPublishFailure] = useState<PublishFailure | null>(null)
  // History (#136): the version shown in the canvas, and the one waiting for confirmation.
  const [viewingVersion, setViewingVersion] = useState<PostVersion | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)

  const [urlStructure, setUrlStructure] = useState<"id" | "slug">("id")
  // For the SEO tab's previews (#357).
  const [site, setSite] = useState({ title: "", address: "" })
  useEffect(() => {
    getSettings()
      .then((settings) => {
        setUrlStructure(settings.post_url_structure)
        setSite({ title: settings.site_title || "", address: settings.site_address || window.location.origin })
      })
      .catch((error) => console.error("Failed to fetch settings:", error))
  }, [])

  // Settings (#358): on a published post, the title, excerpt, featured image and terms
  // reach the site only on Update. `settingsPending` says they differ from the live ones
  // (GET /posts/:id/settings), re-read after each settings save, publish and restore.
  const [settingsPending, setSettingsPending] = useState(false)
  // The live title the site shows (published SEO title, else title), for the SEO tab.
  const [liveTitle, setLiveTitle] = useState<string | null>(null)
  // Bumped when a restored version changed the featured image and terms, to reload them.
  const [settingsKey, setSettingsKey] = useState(0)
  const refreshSettingsState = async () => {
    if (mode !== "edit" || !initialData?.id) return
    try {
      const token = authManager.getAccessToken()
      if (token) blockAPIClient.setAuthToken(token)
      const state = await blockAPIClient.getSettingsState(initialData.id)
      setSettingsPending(state.changed)
      setLiveTitle(state.published ? state.published.seo_title?.trim() || state.published.title : null)
    } catch (error) {
      // Only the hint depends on it.
      console.error("Failed to read the settings state:", error)
    }
  }
  useEffect(() => {
    void refreshSettingsState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialData?.id])

  // The collab server saves the content only, so the title and excerpt are saved on their
  // own, debounced, through PUT /posts/:id. Only for users who may change them.
  const savedTitleRef = useRef(initialData?.title ?? "")
  const savedExcerptRef = useRef(initialData?.description ?? "")
  const titleSaveable = mode === "edit" && roleVerified && !detailsReadOnly && !!initialData?.id
  const saveTitle = async (): Promise<void> => {
    if (!titleSaveable || !initialData?.id) return
    const title = formData.title.trim()
    const excerpt = formData.excerpt.trim()
    // The API's title limit (3+ characters): keep the last saved title until the new
    // one is long enough. The excerpt is optional (#357): empty clears it.
    const changes: Partial<Post> = {}
    if (title !== savedTitleRef.current && title.length >= 3) changes.title = title
    if (excerpt !== savedExcerptRef.current) changes.description = excerpt
    if (Object.keys(changes).length === 0) return
    await updatePost(initialData.id, changes)
    if (changes.title !== undefined) savedTitleRef.current = changes.title
    if (changes.description !== undefined) savedExcerptRef.current = changes.description
    void refreshSettingsState()
  }
  useEffect(() => {
    if (!titleSaveable) return
    const timer = setTimeout(() => {
      saveTitle().catch((error) => {
        showError("Failed to save the title or excerpt")
        console.error("Title save failed:", error)
      })
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.title, formData.excerpt, titleSaveable])

  // SEO (#357): editors and admins only (contributors see the tab read-only). Saved on
  // its own like the title, debounced, through PUT /posts/:id/seo; on a published post
  // the site shows it after Update. A canonical URL the API would refuse waits.
  const [seo, setSeo] = useState<PostSEOSettings>(() => seoFromPost(initialData))
  const savedSeoRef = useRef<PostSEOSettings>(seoFromPost(initialData))
  const [seoError, setSeoError] = useState<string | null>(null)
  const seoSaveableNow = mode === "edit" && roleVerified && canPublish && !!initialData?.id
  const saveSeo = async (): Promise<void> => {
    if (!seoSaveableNow || !initialData?.id) return
    if (sameSeo(seo, savedSeoRef.current) || !seoSaveable(seo)) return
    const body = seoPayload(seo)
    try {
      await updatePostSEO(initialData.id, body)
      savedSeoRef.current = body
      setSeoError(null)
      void refreshSettingsState()
    } catch (error) {
      setSeoError(errorMessage(error, "Couldn't save the SEO settings. Your changes are kept here; try again."))
      throw error
    }
  }
  useEffect(() => {
    if (!seoSaveableNow) return
    const timer = setTimeout(() => {
      saveSeo().catch((error) => console.error("SEO save failed:", error))
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seo, seoSaveableNow])

  // What the meta description falls back to without an excerpt: the first paragraph,
  // from the editor's content (debounced), else the published body.
  const [firstParagraph, setFirstParagraph] = useState(() => firstParagraphText(initialData?.published_blocks))
  useEffect(() => {
    if (!formData.content) return
    const timer = setTimeout(() => setFirstParagraph(firstParagraphFromHtml(formData.content)), 500)
    return () => clearTimeout(timer)
  }, [formData.content])

  const handlePostUpdate = (updates: Partial<Post>) => {
    setFormData((prev) => ({
      ...prev,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.description !== undefined && { excerpt: updates.description }),
      ...(updates.post_status !== undefined && { post_status: updates.post_status as PostFormData["post_status"] }),
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
      savedExcerptRef.current = initialData.description
      savedSeoRef.current = seoFromPost(initialData)
      setSeo(seoFromPost(initialData))

      setFormData({
        title: initialData.title,
        slug: slug,
        content: "",
        excerpt: initialData.description,
        post_status: initialData.post_status as PostFormData["post_status"],
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

  const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // A pasted line break isn't part of a title.
    const title = e.target.value.replace(/\s*\n\s*/g, " ")
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
        await Promise.all([saveTitle(), saveSeo(), editorRef.current.forceSave()])
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
      const wasPublished = formData.post_status === "published"
      try {
        // The settings go out with the content: save any pending edit first.
        await Promise.all([saveTitle(), saveSeo()])
        const result = await editorRef.current.publish()
        if (result) {
          setPublishFailure(null)
          showSuccess(wasPublished ? "Post updated" : "Post published")
          // Update the post status in the form data
          setFormData((prev) => ({ ...prev, post_status: "published" }))
        }
      } catch (error) {
        console.error("Block publish failed:", error)
        // A 503 is the API's answer when the collab server couldn't store the latest
        // edits (the flush failed); a CollabStoreError means they never reached it.
        const storeFailed = (error instanceof ApiError && error.status === 503) || error instanceof CollabStoreError
        setPublishFailure((prev) => ({
          attempts: (prev?.attempts ?? 0) + 1,
          message: error instanceof Error ? error.message : String(error),
          requestId: error instanceof ApiError ? error.requestId : null,
          storeFailed,
        }))
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
      setSettingsPending(false)
      showSuccess("Unpublished: the post is a draft again")
    } catch (error) {
      showError("Failed to unpublish")
      console.error("Unpublish failed:", error)
    }
  }

  // A status change only (PUT /posts/:id with post_status), like the Posts list's row
  // actions: the body stays with the collab server.
  const setStatus = async (status: "archived" | "draft", done: string, failed: string) => {
    if (!canPublish || !initialData?.id) return
    try {
      await updatePost(initialData.id, { post_status: status })
      setFormData((prev) => ({ ...prev, post_status: status }))
      toast.success(done)
    } catch (error) {
      toast.error(errorMessage(error, failed))
      console.error(`Setting the status to ${status} failed:`, error)
    }
  }
  const handleArchive = () => setStatus("archived", "Post archived", "Couldn't archive the post")
  const handleRestoreToDrafts = () => setStatus("draft", "Restored to drafts", "Couldn't restore the post to drafts")

  // Load a version into the working copy through the live editor, so collaborators
  // get it via Yjs (rule 9). Publishing afterwards makes it live (as a new version).
  // Its settings (title, excerpt, featured image, terms; #358) aren't in the Yjs doc:
  // the API puts them back into the working copy once the blocks are in.
  const handleRestoreVersion = async (version: PostVersion) => {
    if (contentReadOnly || !canPublish || !editorRef.current || !initialData?.id) return
    setIsRestoring(true)
    try {
      const { saved } = await editorRef.current.restoreVersion(version.doc)
      const token = authManager.getAccessToken()
      if (token) blockAPIClient.setAuthToken(token)
      let settingsNote = ""
      try {
        const settings = await blockAPIClient.restoreVersionSettings(initialData.id, version.version_no)
        if (settings.restored && settings.post) {
          const { title, description } = settings.post
          // Already saved: the debounced save mustn't send them again.
          savedTitleRef.current = title
          savedExcerptRef.current = description
          setFormData((prev) => ({ ...prev, title, excerpt: description }))
          if (settings.post.seo) {
            savedSeoRef.current = seoFromPost(settings.post)
            setSeo(seoFromPost(settings.post))
          }
          setSettingsKey((k) => k + 1)
        } else {
          settingsNote = " This version was published before settings were saved with it, so only its content came back."
        }
      } catch (error) {
        console.error("Restoring the version's settings failed:", error)
        settingsNote = " Its title, excerpt, image and terms couldn't be restored."
      }
      void refreshSettingsState()
      const live = formData.post_status === "published" ? "Update" : "Publish"
      toast.success(
        (saved
          ? `Working copy restored to ${versionTime(version.created_at)}. ${live} to make it live.`
          : `Working copy restored to ${versionTime(version.created_at)}; saving…`) + settingsNote
      )
      setRevisionsKey((k) => k + 1)
      setConfirmRestore(false)
      setViewingVersion(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't restore that version")
      console.error("Restore failed:", error)
    } finally {
      setIsRestoring(false)
    }
  }

  const copyErrorDetails = async (failure: PublishFailure) => {
    const details = [
      "Publish failed",
      `Post: ${initialData?.id ?? "new"}`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${failure.message}`,
      failure.requestId ? `Error ID: ${failure.requestId}` : null,
    ]
      .filter(Boolean)
      .join("\n")
    try {
      await navigator.clipboard.writeText(details)
      toast.success("Error details copied")
    } catch {
      toast.error("Couldn't copy. Select the details in the banner instead.")
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

      // The excerpt is optional (#357): themes use the first paragraph without one.
      const description = formData.excerpt.trim()

      const baseUrl = window.location.origin
      const postType = contentType || "post"
      const fullUrl = `${baseUrl}/${postType}/${formData.slug}`

      if (mode === "create") {
        // The body as Block Spec v1, sent with the create: built from the editor's document
        // by the collab server's bridge, never from its HTML, which loses marks and attrs.
        const initialBlockDoc = editorRef.current?.getBlockDoc() ?? null
        // With a body, publishing is a separate step (publishPost snapshots the body and
        // sets the status itself), so the post is created as a draft and only goes public
        // once that succeeds. An empty post is published by the create.
        const publishAfterCreate = isPublish && !!initialBlockDoc
        const postData: CreatePostRequest = {
          title: formData.title,
          url: fullUrl,
          slug: formData.slug || undefined,
          content: formData.content,
          description: description,
          author_ids: [authState.user.id],
          post_status: publishAfterCreate ? "draft" : isPublish ? "published" : formData.post_status,
          post_type: postType,
          menu_order: 0,
          // The body goes in with the post; the collab server seeds the doc from it on
          // first open.
          ...(initialBlockDoc ? { block_doc: initialBlockDoc } : {}),
        }

        const result = await createPost(postData)
        setSaveStatusState("saved")

        console.log("📝 Post created successfully:", {
          postId: result.post.id,
          title: result.post.title,
          hasContent: !!formData.content,
          contentLength: formData.content?.length || 0,
          contentPreview: formData.content?.substring(0, 100),
        })

        let published = isPublish
        if (publishAfterCreate) {
          try {
            const token = authManager.getAccessToken()
            if (token) blockAPIClient.setAuthToken(token)
            await blockAPIClient.publishPost(result.post.id)
          } catch (error) {
            // The post exists as a draft; it can be published from the editor.
            published = false
            console.error("❌ Failed to publish the new post:", error)
            showError("Saved as a draft, but publishing failed. Try publishing again from the editor.")
          }
        }
        if (published || !isPublish) {
          showSuccess(`${getContentTypeName(postType)} ${published ? "published" : "saved"} successfully!`)
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
  const postType = contentType || initialData?.post_type || "post"
  const liveUrl =
    mode === "edit" && initialData?.id
      ? `${window.location.origin}/${postType}/${urlStructure === "slug" && formData.slug ? formData.slug : initialData.id}`
      : null
  const signedIn = authManager.getState().user
  const others = Array.from(new Map(collabUsers.filter((u) => u.id !== signedIn?.id).map((u) => [u.id ?? -u.clientId, u])).values())
  const archived = formData.post_status === "archived"
  const historyEnabled = mode === "edit" && collabEnabled && canPublish && !contentReadOnly

  return (
    <div className={`post-editor post-editor--${connection}`}>
      <EditorTopBar
        listLabel={`${contentTypeName}s`}
        listHref={getBackUrl()}
        title={formData.title}
        postStatus={formData.post_status}
        mode={mode}
        saveStatus={saveStatus}
        connection={connection}
        live={collabStatus === "connected"}
        collabUsers={collabUsers}
        me={signedIn ? { id: signedIn.id, name: signedIn.full_name || signedIn.username } : undefined}
        viewOnly={contentReadOnly}
        canPublish={canPublish}
        isPublishing={isSubmitting}
        isSaving={isSaving}
        settingsOpen={sidebarVisible}
        onSettingsToggle={() => setSidebarVisible(!sidebarVisible)}
        onSave={handleSave}
        onPublish={handlePublish}
        onUnpublish={collabEnabled && canPublish ? handleUnpublish : undefined}
        onArchive={collabEnabled && canPublish ? handleArchive : undefined}
        onRestoreToDrafts={collabEnabled && canPublish ? handleRestoreToDrafts : undefined}
        liveUrl={liveUrl}
        settingsPending={settingsPending}
        viewing={
          viewingVersion
            ? {
                label: `Viewing version published ${versionTime(viewingVersion.created_at)}`,
                onBack: () => setViewingVersion(null),
                onRestore: () => setConfirmRestore(true),
              }
            : null
        }
      />

      {/* Banners across the editor: only when you need to act or wait. */}
      {connection === "offline" && !contentReadOnly && (
        <Notice tone="warning" live="alert" className="post-editor__banner" title="You're offline">
          Your edits wait in this tab and are sent when you're back online. Keep this tab open until then. You can
          {formData.post_status === "published" ? " update" : " publish"} once you're connected.
        </Notice>
      )}
      {publishFailure && (
        <Notice
          tone="danger"
          live="alert"
          inline
          className="post-editor__banner"
          title="Publish failed"
          onDismiss={() => setPublishFailure(null)}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={handlePublish} loading={isSubmitting} disabled={collabStatus !== "connected"}>
                Try again
              </Button>
              {publishFailure.attempts > 1 && (
                <Button variant="ghost" size="sm" onClick={() => copyErrorDetails(publishFailure)}>
                  Copy error details
                </Button>
              )}
            </>
          }
        >
          {publishFailure.storeFailed
            ? "The server couldn't save your latest edits, so nothing was published. The live post hasn't changed."
            : "Nothing was published. The live post hasn't changed."}
          {publishFailure.attempts > 1 && publishFailure.requestId && (
            <span className="post-editor__error-id"> Error ID: {publishFailure.requestId}</span>
          )}
        </Notice>
      )}
      {archived && mode === "edit" && (
        <div className="post-editor__archived" role="note">
          <ArchiveIcon size={16} />
          <span>It isn't on the site and only shows under the Archived tab.</span>
        </div>
      )}

      <div className="post-editor__body">
        <main className="post-editor__canvas">
          {viewingVersion && (
            <div className="post-editor__document">
              <VersionPreview version={viewingVersion} />
            </div>
          )}
          {/* Hidden, not unmounted, while a version is shown: the bound editor stays connected. */}
          <div className="post-editor__document" hidden={!!viewingVersion}>
            <div className="post-editor__title">
              {/* A textarea so a long title wraps (it grows with field-sizing); one line of text. */}
              <textarea
                rows={1}
                placeholder="Add title"
                value={formData.title}
                onChange={handleTitleChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault()
                }}
                className="post-editor__title-input"
                id="post-title"
                name="post-title"
                aria-label="Title"
                readOnly={detailsReadOnly}
              />
            </div>

            <div className="post-editor__content">
              {roleVerified && contentReadOnly && (
                <Notice tone="info" live="status" className="post-editor__notice">
                  <strong>View-only:</strong> you can edit only posts you wrote. You still see others' changes as they
                  type.
                </Notice>
              )}
              {roleVerified && !contentReadOnly && detailsReadOnly && (
                <Notice tone="info" live="status" className="post-editor__notice">
                  This post is published. Your changes are saved as a draft and go live when an editor publishes them.
                  The title and settings are locked.
                </Notice>
              )}
            {/* Mount only once the current role is known, so a stale cached role never
                opens a collab connection the server would reject. */}
            {roleVerified && (
            <Editor
              ref={editorRef}
              readOnly={contentReadOnly}
              // The server re-checked access and it changed (#313): the role cached here is
              // stale. Not after a revoke (the editor shows "sign in again"), nor when the
              // server just couldn't confirm access (the API is struggling; no role change).
              onAccessChange={(change) => {
                if (change.revoked || change.reason === "unverified") return
                void authManager.refreshUser().then((user) => setMe(user ?? undefined))
              }}
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
                // The top bar says "Latest edits not saved"; the server keeps retrying.
                setSaveStatus("error")
                // A save can be refused because an editor published the post meanwhile,
                // which locks its title for a contributor (#135). Re-read the status and
                // title so the locks catch up and later saves stop sending the refused title.
                if (!canPublish && initialData?.id) {
                  getPostById(initialData.id)
                    .then(({ post }) =>
                      setFormData((prev) =>
                        post.post_status === prev.post_status
                          ? prev
                          : { ...prev, post_status: post.post_status as PostFormData["post_status"], title: post.title }
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
                // The settings went out with it (#358).
                setSettingsPending(false)
              }}
              onPublishError={() => {
                // handlePublish shows the "Publish failed" banner.
                setIsSubmitting(false)
              }}
            />
            )}
            </div>
          </div>
        </main>

        <PostSidebar
          post={currentPost}
          onUpdate={handlePostUpdate}
          isVisible={sidebarVisible}
          onToggle={() => setSidebarVisible(!sidebarVisible)}
          sidebarWidth={sidebarWidth}
          onResize={handleSidebarResize}
          slug={formData.slug}
          mode={mode}
          onSlugChange={handleSlugChange}
          readOnly={detailsReadOnly}
          urlStructure={urlStructure}
          onSettingsSaved={() => void refreshSettingsState()}
          settingsKey={settingsKey}
          settingsPending={settingsPending}
          seo={
            mode === "edit" && initialData?.id
              ? {
                  value: seo,
                  onChange: setSeo,
                  readOnly: !seoSaveableNow,
                  firstParagraph,
                  siteName: site.title,
                  siteAddress: site.address || window.location.origin,
                  path: postPath({ id: initialData.id, slug: formData.slug, post_type: postType }, urlStructure),
                  liveTitle,
                  error: seoError,
                }
              : undefined
          }
          history={
            historyEnabled && initialData?.id
              ? {
                  refreshKey: revisionsKey,
                  viewingVersionNo: viewingVersion?.version_no ?? null,
                  onView: setViewingVersion,
                  onBackToWorkingCopy: () => setViewingVersion(null),
                }
              : undefined
          }
        />
      </div>

      {/* History · 2: confirm before replacing everyone's working copy. */}
      <Modal
        isOpen={confirmRestore && !!viewingVersion}
        onClose={() => !isRestoring && setConfirmRestore(false)}
        size="small"
        title={viewingVersion ? `Restore the version published ${versionTime(viewingVersion.created_at)}?` : undefined}
        description="It replaces the working copy for everyone in this post, its title, excerpt, image and terms included, along with changes that haven't been published. The live post stays as it is until someone publishes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRestore(false)} disabled={isRestoring}>
              Cancel
            </Button>
            <Button variant="primary" loading={isRestoring} onClick={() => viewingVersion && handleRestoreVersion(viewingVersion)}>
              Restore version
            </Button>
          </>
        }
      >
        {others.length > 0 ? (
          <div className="post-editor__restore-people">
            <AvatarStack
              users={others.map((u) => ({ id: u.id ?? -u.clientId, name: u.name ?? "Guest" }))}
              size={24}
              max={3}
            />
            <span>
              {listNames(others.map((u) => u.name ?? "Guest"))} {others.length === 1 ? "is" : "are"} in this post now.
              They'll see it change.
            </span>
          </div>
        ) : null}
      </Modal>

      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  )
}

// "Ana", "Ana and Marco", "Ana, Marco and 2 others".
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? "" : "s"}`
}
