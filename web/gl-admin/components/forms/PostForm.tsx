import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import {
  cancelPostSchedule,
  cancelScheduledUpdate,
  createPost,
  getPostById,
  schedulePost,
  scheduleUpdate,
  updatePost,
  updatePostSEO,
} from "@gl-admin/lib/api/posts"
import { getPostOwner, type CreatePostRequest } from "@gl-admin/lib/api/posts"
import type { Post, PostSEOSettings, ScheduledUpdate } from "@gl-admin/lib/api/types"
import { firstParagraphFromHtml, sameSeo, seoFromPost, seoPayload, seoSaveable } from "@gl-admin/lib/postSeo"
import { firstParagraphText, postPath } from "@/lib/seo"
import { authManager } from "@gl-admin/lib/auth"
import { blockAPIClient, type PostVersion } from "@gl-admin/lib/api/blockAPI"
import { getSettings, type PostUrlStructure } from "@gl-admin/lib/api/settings"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { CollabStoreError } from "@gl-admin/lib/collaboration/CollabSaveStatus"
import Editor, { type EditorRef } from "@gl-admin/components/editor/Editor"
import EditorTopBar, { ArchiveIcon, OfflineIcon } from "@gl-admin/components/editor/ui/EditorTopBar"
import PostSidebar, { type SettingsTab } from "@gl-admin/components/editor/ui/PostSidebar"
import type { Editor as TiptapEditor } from "@tiptap/core"
import CommentsPanel from "@gl-admin/components/editor/ui/CommentsPanel"
import { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import ScheduleDialog from "@gl-admin/components/editor/ui/ScheduleDialog"
import { useSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import {
  formatScheduleTime,
  scheduledUpdateEndedMessage,
  scheduledUpdateErrorMessage,
  scheduleFailureMessage,
  zoneCity,
} from "@gl-admin/lib/schedule"
import ScheduledUpdateNotice from "@gl-admin/components/editor/ui/ScheduledUpdateNotice"
import ReviewRequestNotice from "@gl-admin/components/editor/ui/ReviewRequestNotice"
import { RequestChangesDialog, RequestReviewDialog } from "@gl-admin/components/editor/ui/ReviewDialogs"
import {
  dismissReviewRequest,
  getPostReviewRequest,
  requestReview,
  requestReviewChanges,
  type ReviewRequest,
} from "@gl-admin/lib/api/reviewRequests"
import { REVIEW_ALREADY_REQUESTED, reviewErrorMessage, reviewPersonName } from "@gl-admin/lib/reviewRequests"
import { VersionPreview, versionTime } from "@gl-admin/components/editor/ui/RevisionsPanel"
import Notice from "@gl-admin/components/ui/Notice"
import Button from "@gl-admin/components/ui/Button"
import Modal from "@gl-admin/components/ui/Modal"
import FrontPageConfirm from "@gl-admin/components/content/FrontPageConfirm"
import { isFrontPage } from "@gl-admin/lib/frontPage"
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
import { getPostAccess, type PostAccess } from "@gl-admin/lib/api/postAccess"
import { AccessRequestsNotice, PostCollaborators, ViewOnlyNotice } from "@gl-admin/components/editor/ui/PostEditAccess"
import { canTransferPost } from "@gl-admin/lib/postOwner"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"

// After the collab server stores a changed body, how long to wait for the next store of the
// same burst of typing before re-reading "Changes not published" (#326).
const STORED_REFRESH_DELAY_MS = 500

// A failed publish (#341, "Publish failed"): the banner offers Try again, and after a
// second failure "Copy error details" for support.
type PublishFailure = { attempts: number; message: string; requestId: string | null; storeFailed: boolean }

// Scheduled publishing (#147): when the time has come, how long to wait before the first
// look (the scheduler runs every 30s) and between looks.
const SCHEDULE_POLL_DELAY_MS = 5_000
const SCHEDULE_POLL_MS = 15_000

interface PostFormData {
  title: string
  slug: string
  content: string
  excerpt: string
  post_status: "draft" | "published" | "scheduled" | "archived"
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
    page_template: initialData?.page_template,
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
  // Edit access requests and grants (#321): GET /posts/:id/access, read with the role
  // before the editor mounts (a grant makes it editable), and again whenever the collab
  // server's re-check changed this connection's access (a grant or a revoke) or a request
  // was made or answered here. null = not loaded or failed: ownership alone decides.
  const [postAccess, setPostAccess] = useState<PostAccess | null>(null)
  const accessRead = useRef(0)
  const postIdForAccess = mode === "edit" ? initialData?.id : undefined
  const reloadAccess = useCallback(async () => {
    if (!postIdForAccess) return
    const read = ++accessRead.current
    const next = await getPostAccess(postIdForAccess).catch(() => null)
    // Only the latest read's answer counts.
    if (read === accessRead.current) setPostAccess(next)
  }, [postIdForAccess])
  useEffect(() => {
    if (mode !== "edit") return
    let cancelled = false
    Promise.all([authManager.refreshUser(), reloadAccess()]).then(([user]) => {
      if (cancelled) return
      setMe(user ?? undefined)
      setRoleVerified(true)
    })
    return () => {
      cancelled = true
    }
  }, [mode, reloadAccess])

  // The owner decides access (#135); a Transfer (#353) changes it while open: here after
  // our own, and in every other open form when the collab re-check changes its access.
  const [ownerId, setOwnerId] = useState<number | undefined>(initialData?.user_id)
  useEffect(() => setOwnerId(initialData?.user_id), [initialData?.user_id])
  const access = postEditorAccess(
    me,
    mode,
    mode === "edit" && initialData
      ? { user_id: ownerId ?? initialData.user_id, post_status: formData.post_status, collaborator: postAccess?.collaborator }
      : undefined
  )
  const contentReadOnly = !access.content
  const detailsReadOnly = !access.details
  const canPublish = access.publish
  // A user who can't edit the post still gets the live doc, read-only (the collab server
  // makes that connection read-only).
  const collabEnabled = mode === "edit" && roleVerified

  // Scheduled publishing (#147): the time (UTC ISO) and the last failed attempt, if any.
  const [publishAt, setPublishAt] = useState<string | null>(initialData?.publish_at ?? null)
  const [scheduleFailure, setScheduleFailure] = useState(initialData?.schedule_failure ?? null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // A published post's scheduled update (#335): its content was frozen when scheduled.
  const [scheduledUpdate, setScheduledUpdate] = useState<ScheduledUpdate | null>(initialData?.scheduled_update ?? null)
  const [scheduleUpdateOpen, setScheduleUpdateOpen] = useState(false)

  // Review requests (#323): the post's open request, or the latest one when a reviewer
  // asked for changes and nothing was published since. Re-read on open, after a publish
  // (which resolves it) and when the tab is shown again (someone else may have acted).
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(null)
  const [requestReviewOpen, setRequestReviewOpen] = useState(false)
  const [requestChangesOpen, setRequestChangesOpen] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const reviewReadRef = useRef(0)
  const refreshReview = async () => {
    if (mode !== "edit" || !initialData?.id) return
    const read = ++reviewReadRef.current
    try {
      const current = await getPostReviewRequest(initialData.id)
      if (read === reviewReadRef.current) setReviewRequest(current)
    } catch (error) {
      // Only the notice depends on it.
      console.error("Failed to read the review request:", error)
    }
  }
  useEffect(() => {
    void refreshReview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialData?.id])
  const dateSettings = useSiteDateSettings()

  const { status: collabStatus, users: collabUsers, unsynced, unsyncedCount } = useCollabPresence(initialData?.id, collabEnabled)
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
  // "Highlight changes" (#355) re-reads the working copy when the collab server stored it.
  const [workingCopyKey, setWorkingCopyKey] = useState(0)
  const viewingVersionRef = useRef(false)
  viewingVersionRef.current = !!viewingVersion
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)

  const [urlStructure, setUrlStructure] = useState<PostUrlStructure>("id")
  // For the SEO tab's previews (#357).
  const [site, setSite] = useState({ title: "", address: "" })
  // The front page (#336): unpublishing or archiving it asks first (the home page falls
  // back to the latest posts).
  const [frontPageId, setFrontPageId] = useState<number | null>(null)
  const [confirmFront, setConfirmFront] = useState<"unpublish" | "archive" | null>(null)
  useEffect(() => {
    getSettings()
      .then((settings) => {
        setUrlStructure(settings.post_url_structure)
        setSite({ title: settings.site_title || "", address: settings.site_address || window.location.origin })
        setFrontPageId(settings.front_page_id ?? null)
      })
      .catch((error) => console.error("Failed to fetch settings:", error))
  }, [])

  // Settings (#358): on a published post, the title, excerpt, featured image and terms
  // reach the site only on Update. `settingsPending` says they differ from the live ones,
  // `contentPending` that the body does (#326): together they're "Changes not published".
  // Both come from GET /posts/:id/settings, re-read after each settings save, publish and
  // restore, and whenever the collab server stores a changed body (anyone's edits).
  const [settingsPending, setSettingsPending] = useState(false)
  const [contentPending, setContentPending] = useState(false)
  // The live title the site shows (published SEO title, else title), for the SEO tab.
  const [liveTitle, setLiveTitle] = useState<string | null>(null)
  // Bumped when a restored version changed the featured image and terms, to reload them.
  const [settingsKey, setSettingsKey] = useState(0)
  // Only the latest read's answer counts: reads overlap while collaborators type.
  const settingsReadRef = useRef(0)
  const refreshSettingsState = async () => {
    if (mode !== "edit" || !initialData?.id) return
    const read = ++settingsReadRef.current
    try {
      const token = authManager.getAccessToken()
      if (token) blockAPIClient.setAuthToken(token)
      const state = await blockAPIClient.getSettingsState(initialData.id)
      if (read !== settingsReadRef.current) return
      setSettingsPending(state.changed)
      setContentPending(state.blocks_changed)
      setLiveTitle(state.published ? state.published.seo_title?.trim() || state.published.title : null)
      // A scheduled update made, changed or cancelled in another tab (#335).
      if (state.scheduled_update !== undefined) setScheduledUpdate(state.scheduled_update)
    } catch (error) {
      // Only the hint depends on it.
      console.error("Failed to read the settings state:", error)
    }
  }
  // Stores come every few seconds while people type: one read per burst.
  const storedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const handleStored = () => {
    clearTimeout(storedTimerRef.current)
    storedTimerRef.current = setTimeout(() => {
      void refreshSettingsState()
      if (viewingVersionRef.current) setWorkingCopyKey((k) => k + 1)
    }, STORED_REFRESH_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(storedTimerRef.current), [])
  // Scheduling or cancelling an update (#335) stores nothing, so a tab that was in the
  // background re-reads the state when it's shown again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      void refreshSettingsState()
      void refreshReview()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
  // the site shows it after Update. A canonical URL the API would refuse isn't sent (the
  // last saved one is), so it never holds the other fields back; Update waits for it.
  const [seo, setSeo] = useState<PostSEOSettings>(() => seoFromPost(initialData))
  const savedSeoRef = useRef<PostSEOSettings>(seoFromPost(initialData))
  const seoLoadedForRef = useRef<number | undefined>(initialData?.id)
  const [seoError, setSeoError] = useState<string | null>(null)
  const seoSaveableNow = mode === "edit" && roleVerified && canPublish && !!initialData?.id
  const saveSeo = async (): Promise<void> => {
    if (!seoSaveableNow || !initialData?.id) return
    const next = seoSaveable(seo) ? seo : { ...seo, canonical_url: savedSeoRef.current.canonical_url }
    if (sameSeo(next, savedSeoRef.current)) return
    const body = seoPayload(next)
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
      // Only for another post: a refetch of this one mustn't drop an SEO edit that is
      // still waiting for its debounced save.
      if (seoLoadedForRef.current !== initialData.id) {
        seoLoadedForRef.current = initialData.id
        savedSeoRef.current = seoFromPost(initialData)
        setSeo(seoFromPost(initialData))
      }

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

  // Block comments (#192): one store per open post, shared by the editor (markers, the
  // block menu's Comment, Ctrl M, the nudge) and the panel. In memory only.
  const commentsPostId = mode === "edit" && roleVerified ? initialData?.id : undefined
  const [comments, setComments] = useState<PostCommentsStore | null>(null)
  useEffect(() => {
    if (!commentsPostId) return
    const store = new PostCommentsStore(commentsPostId)
    setComments(store)
    void store.refresh()
    const offVisible = store.watchVisibility()
    // A block asked for (marker, hover button, block menu, Ctrl M): open the panel.
    let lastFocus = 0
    const offFocus = store.subscribe(() => {
      const focus = store.getSnapshot().focus
      if (focus && focus.seq !== lastFocus) {
        lastFocus = focus.seq
        setCommentsOpen(true)
      }
    })
    return () => {
      offVisible()
      offFocus()
      store.destroy()
      setComments(null)
    }
  }, [commentsPostId])
  const [commentsOpen, setCommentsOpen] = useState(false)
  // The settings panel's Block tab (#417): the editable editor, and ⌘⇧, (open the panel on
  // Block, or close it when Block is what it shows).
  const [blockEditor, setBlockEditor] = useState<TiptapEditor | null>(null)
  const [settingsTabRequest, setSettingsTabRequest] = useState<{ tab: SettingsTab; key: number } | null>(null)
  const settingsTab = useRef<SettingsTab>("post")
  const settingsShown = useRef(false)
  settingsShown.current = sidebarVisible && !commentsOpen
  // ↵ on a gallery image (#424): the Block tab, never a toggle.
  const openBlockSettings = useCallback(() => {
    setCommentsOpen(false)
    setSidebarVisible(true)
    setSettingsTabRequest((previous) => ({ tab: "block", key: (previous?.key ?? 0) + 1 }))
  }, [])
  const toggleBlockSettings = useCallback(() => {
    if (settingsShown.current && settingsTab.current === "block") {
      // The key comes from the editor, which keeps focus.
      setSidebarVisible(false)
      return
    }
    openBlockSettings()
  }, [openBlockSettings])
  // Only the count: the store changes on every keystroke (the blocks), the count doesn't.
  const openComments = useSyncExternalStore(comments?.subscribe ?? noSubscribe, comments?.openCount ?? noCount)

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
      if (seoSaveableNow && !seoSaveable(seo)) {
        // Publishing would go out with the last valid canonical URL, not the one shown.
        showError("Fix the canonical URL in the SEO tab first.")
        return
      }
      try {
        // The settings go out with the content: save any pending edit first.
        await Promise.all([saveTitle(), saveSeo()])
        const result = await editorRef.current.publish()
        if (result) {
          setPublishFailure(null)
          // An Update by hand supersedes a scheduled update (#335): the API ends it.
          // The API says whether it superseded one, whichever tab scheduled it.
          showSuccess(
            wasPublished
              ? result.cancelledScheduledUpdate
                ? "Post updated · the scheduled update was cancelled"
                : "Post updated"
              : "Post published"
          )
          // Update the post status in the form data. Publishing ends a schedule (#147).
          setFormData((prev) => ({ ...prev, post_status: "published" }))
          setPublishAt(null)
          setScheduleFailure(null)
          setScheduledUpdate(null)
          // Publishing resolves an open review request (#323).
          void refreshReview()
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
      setContentPending(false)
      // Unpublishing ends a scheduled update (#335).
      setScheduledUpdate(null)
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
      // Leaving "published" ends a scheduled update (#335).
      setScheduledUpdate(null)
      toast.success(done)
    } catch (error) {
      toast.error(errorMessage(error, failed))
      console.error(`Setting the status to ${status} failed:`, error)
    }
  }
  const handleArchive = () => setStatus("archived", "Post archived", "Couldn't archive the post")
  // The Publish menu's Unpublish and Archive, asking first on the front page (#336).
  const isFront = isFrontPage(initialData?.id ? { id: initialData.id, post_type: currentPost.post_type } : null, frontPageId)
  const askUnpublish = async () => (isFront ? setConfirmFront("unpublish") : handleUnpublish())
  const askArchive = async () => (isFront ? setConfirmFront("archive") : handleArchive())
  const handleRestoreToDrafts = () => setStatus("draft", "Restored to drafts", "Couldn't restore the post to drafts")

  // Schedule or reschedule (#147): `local` is the dialog's time in the site's zone. A
  // rejection is shown in the dialog.
  const handleSchedule = async (local: string) => {
    if (!canPublish || !initialData?.id) return
    await saveTitle()
    const { post } = await schedulePost(initialData.id, local)
    const rescheduled = formData.post_status === "scheduled"
    setFormData((prev) => ({ ...prev, post_status: "scheduled" }))
    setPublishAt(post.publish_at ?? null)
    setScheduleFailure(null)
    // publish_at is the stored instant; the wall-clock `local` would parse in the browser's zone.
    const when = post.publish_at ? ` for ${formatScheduleTime(post.publish_at, dateSettings, { withTime: true })}` : ""
    toast.success(`${rescheduled ? "Rescheduled" : "Scheduled"}${when}`)
  }

  const handleCancelSchedule = async () => {
    if (!canPublish || !initialData?.id) return
    try {
      await cancelPostSchedule(initialData.id)
      setFormData((prev) => ({ ...prev, post_status: "draft" }))
      setPublishAt(null)
      setScheduleFailure(null)
      toast.success("Schedule cancelled: the post is a draft again")
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't cancel the schedule"))
    }
  }

  // Schedule or reschedule a published post's Update (#335). The content is frozen now:
  // pending settings are saved and this tab's edits reach the collab server first (as
  // for Update), then the API flushes it and copies the working copy. A rejection is
  // shown in the dialog.
  const handleScheduleUpdate = async (local: string) => {
    if (!canPublish || !initialData?.id) return
    if (seoSaveableNow && !seoSaveable(seo)) throw new Error("Fix the canonical URL in the SEO tab first.")
    await Promise.all([saveTitle(), saveSeo()])
    await editorRef.current?.whenAcknowledged()
    const rescheduled = !!scheduledUpdate
    try {
      const { scheduled_update } = await scheduleUpdate(initialData.id, local)
      setScheduledUpdate(scheduled_update)
      const when = formatScheduleTime(scheduled_update.update_at, dateSettings, { withTime: true })
      toast.success(`${rescheduled ? "Update rescheduled" : "Update scheduled"} for ${when}`)
    } catch (error) {
      if (error instanceof ApiError) throw new Error(scheduledUpdateErrorMessage(error.code ?? undefined, error.message))
      throw error
    }
  }

  const handleCancelScheduledUpdate = async () => {
    if (!canPublish || !initialData?.id) return
    try {
      await cancelScheduledUpdate(initialData.id)
      setScheduledUpdate(null)
      toast.success("Scheduled update cancelled: the live post stays as it is")
    } catch (error) {
      // Already gone (applied, or ended elsewhere): follow the server.
      if (error instanceof ApiError && error.code === "not_scheduled") setScheduledUpdate(null)
      toast.error(errorMessage(error, "Couldn't cancel the scheduled update"))
    }
  }

  // The scheduler applies the update in the API: once its time has come, re-read the
  // post until the update is gone (applied, or ended elsewhere), so this tab follows.
  const updateScheduledId = formData.post_status === "published" && scheduledUpdate ? initialData?.id : undefined
  const updateAt = scheduledUpdate?.update_at ?? null
  useEffect(() => {
    if (!updateScheduledId || !updateAt) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const { post } = await getPostById(updateScheduledId)
        if (cancelled) return
        const pending = post.scheduled_update ?? null
        if (!pending) {
          setScheduledUpdate(null)
          if (post.post_status === "published") {
            setRevisionsKey((k) => k + 1)
            void refreshSettingsState()
            // Gone: applied, or cancelled / superseded by an Update elsewhere. The
            // newest version tells (versions are editors' and admins' only).
            let latest: string | null = null
            try {
              const token = authManager.getAccessToken()
              if (token) blockAPIClient.setAuthToken(token)
              latest = (await blockAPIClient.listVersions(updateScheduledId)).versions[0]?.created_at ?? null
            } catch {
              // Say only what is known.
            }
            if (cancelled) return
            toast.success(scheduledUpdateEndedMessage(latest, updateAt))
          } else {
            setFormData((prev) => ({ ...prev, post_status: post.post_status as PostFormData["post_status"] }))
          }
          return
        }
        if (pending.update_at !== updateAt) {
          setScheduledUpdate(pending)
          return
        }
        setScheduledUpdate((prev) => (prev && prev.failure?.failed_at === pending.failure?.failed_at ? prev : pending))
        const next = pending.failure?.next_attempt_at ? Date.parse(pending.failure.next_attempt_at) : NaN
        if (!Number.isNaN(next)) {
          timer = setTimeout(check, Math.max(SCHEDULE_POLL_MS, next - Date.now() + SCHEDULE_POLL_DELAY_MS))
          return
        }
      } catch {
        // Try again on the next round.
      }
      if (!cancelled) timer = setTimeout(check, SCHEDULE_POLL_MS)
    }
    const wait = Math.max(0, new Date(updateAt).getTime() - Date.now()) + SCHEDULE_POLL_DELAY_MS
    if (wait < 2 ** 31 - 1) timer = setTimeout(check, wait)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateScheduledId, updateAt])

  // The scheduler publishes in the API: once the time has come, re-read the post until it
  // isn't scheduled any more (or a failure shows), so this tab follows.
  const scheduledId = formData.post_status === "scheduled" && publishAt ? initialData?.id : undefined
  useEffect(() => {
    if (!scheduledId || !publishAt) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const { post } = await getPostById(scheduledId)
        if (cancelled) return
        setScheduleFailure(post.schedule_failure ?? null)
        if (post.post_status !== "scheduled") {
          setFormData((prev) => ({ ...prev, post_status: post.post_status as PostFormData["post_status"] }))
          setPublishAt(null)
          if (post.post_status === "published") {
            setRevisionsKey((k) => k + 1)
            toast.success("The scheduled post is live")
          }
          return
        }
        if (post.publish_at !== publishAt) {
          setPublishAt(post.publish_at ?? null)
          return
        }
        // After a failed attempt nothing changes before the next one (30s to 10 min away).
        const next = post.schedule_failure?.next_attempt_at ? Date.parse(post.schedule_failure.next_attempt_at) : NaN
        if (!cancelled && !Number.isNaN(next)) {
          timer = setTimeout(check, Math.max(SCHEDULE_POLL_MS, next - Date.now() + SCHEDULE_POLL_DELAY_MS))
          return
        }
      } catch {
        // Try again on the next round.
      }
      if (!cancelled) timer = setTimeout(check, SCHEDULE_POLL_MS)
    }
    const wait = Math.max(0, new Date(publishAt).getTime() - Date.now()) + SCHEDULE_POLL_DELAY_MS
    // setTimeout overflows past ~24.8 days; a schedule further out is checked on reload.
    if (wait < 2 ** 31 - 1) timer = setTimeout(check, wait)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scheduledId, publishAt])

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

  // Review requests (#323). Asking saves pending settings and lets this tab's edits
  // reach the collab server first, so the reviewer opens what was asked about.
  const handleRequestReview = async (body: { reviewer_id?: number; message?: string }) => {
    if (!initialData?.id) return
    await saveTitle()
    await editorRef.current?.whenAcknowledged()
    try {
      setReviewRequest(await requestReview(initialData.id, body))
      toast.success(body.reviewer_id ? "Review requested · the reviewer was emailed" : "Review requested · the editors were emailed")
    } catch (error) {
      if (error instanceof ApiError && error.code === REVIEW_ALREADY_REQUESTED) {
        // Someone asked meanwhile: show theirs.
        void refreshReview()
        toast.info(reviewErrorMessage(error.code, ""))
        return
      }
      throw new Error(error instanceof ApiError ? reviewErrorMessage(error.code, error.message) : errorMessage(error, "Couldn't request a review"))
    }
  }

  const reviewAction = async (action: () => Promise<ReviewRequest>, done: string, failed: string) => {
    setReviewBusy(true)
    try {
      const resolved = await action()
      // A dismissed request leaves no notice; changes requested shows the note.
      setReviewRequest(resolved.status === "changes_requested" ? resolved : null)
      toast.success(done)
    } catch (error) {
      if (error instanceof ApiError && error.code === "review_not_open") void refreshReview()
      toast.error(error instanceof ApiError ? reviewErrorMessage(error.code, error.message) : errorMessage(error, failed))
    } finally {
      setReviewBusy(false)
    }
  }
  const handleDismissReview = () => {
    if (!reviewRequest) return
    const withdrawing = reviewRequest.requested_by?.id === me?.id
    void reviewAction(
      () => dismissReviewRequest(reviewRequest.id),
      withdrawing ? "Review request withdrawn" : "Review request dismissed",
      "Couldn't dismiss the review request"
    )
  }
  const handleRequestChanges = async (note: string) => {
    if (!reviewRequest) return
    try {
      const resolved = await requestReviewChanges(reviewRequest.id, note)
      setReviewRequest(resolved)
      toast.success("Changes requested · the author was emailed")
    } catch (error) {
      if (error instanceof ApiError && error.code === "review_not_open") void refreshReview()
      throw new Error(error instanceof ApiError ? reviewErrorMessage(error.code, error.message) : errorMessage(error, "Couldn't request changes"))
    }
  }
  const reviewOpen = reviewRequest?.status === "open"
  // Anyone who may edit the post may ask (the API's canRequestReview = canEditPost).
  const canRequestReview = mode === "edit" && roleVerified && !contentReadOnly && !!initialData?.id

  const contentTypeName = getContentTypeName()
  const postType = contentType || initialData?.post_type || "post"
  const liveUrl =
    mode === "edit" && initialData?.id
      ? `${window.location.origin}/${postType}/${urlStructure !== "id" && formData.slug ? formData.slug : initialData.id}`
      : null
  const signedIn = authManager.getState().user
  const others = Array.from(new Map(collabUsers.filter((u) => u.id !== signedIn?.id).map((u) => [u.id ?? -u.clientId, u])).values())
  const archived = formData.post_status === "archived"
  const scheduled = formData.post_status === "scheduled"
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
        // Click a collaborator's avatar: scroll to their caret (#356).
        onJumpToCursor={collabEnabled ? (clientIds) => editorRef.current?.jumpToCollaborator(clientIds) ?? false : undefined}
        unsyncedCount={unsyncedCount}
        me={signedIn ? { id: signedIn.id, name: signedIn.full_name || signedIn.username, src: signedIn.avatar } : undefined}
        viewOnly={contentReadOnly}
        canPublish={canPublish}
        isPublishing={isSubmitting}
        isSaving={isSaving}
        settingsOpen={sidebarVisible && !commentsOpen}
        onSettingsToggle={() => {
          // One panel beside the canvas at a time.
          if (commentsOpen) {
            setCommentsOpen(false)
            setSidebarVisible(true)
          } else setSidebarVisible(!sidebarVisible)
        }}
        commentsOpen={commentsOpen}
        onCommentsToggle={comments ? () => setCommentsOpen((open) => !open) : undefined}
        openComments={openComments}
        onSave={handleSave}
        onPublish={handlePublish}
        onUnpublish={collabEnabled && canPublish ? askUnpublish : undefined}
        onArchive={collabEnabled && canPublish ? askArchive : undefined}
        onRestoreToDrafts={collabEnabled && canPublish ? handleRestoreToDrafts : undefined}
        liveUrl={liveUrl}
        settingsPending={settingsPending}
        contentPending={contentPending}
        publishAt={formData.post_status === "scheduled" ? publishAt : null}
        onSchedule={collabEnabled && canPublish && formData.post_status !== "published" ? () => setScheduleOpen(true) : undefined}
        onCancelSchedule={collabEnabled && canPublish ? handleCancelSchedule : undefined}
        updateAt={formData.post_status === "published" ? (scheduledUpdate?.update_at ?? null) : null}
        onScheduleUpdate={collabEnabled && canPublish && formData.post_status === "published" ? () => setScheduleUpdateOpen(true) : undefined}
        onCancelScheduledUpdate={collabEnabled && canPublish ? handleCancelScheduledUpdate : undefined}
        reviewRequested={reviewOpen}
        onRequestReview={collabEnabled && canRequestReview ? () => setRequestReviewOpen(true) : undefined}
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

      {mode === "edit" && canPublish && (
        <ScheduleDialog
          isOpen={scheduleOpen}
          onClose={() => setScheduleOpen(false)}
          publishAt={scheduled ? publishAt : null}
          settings={dateSettings}
          onSchedule={handleSchedule}
        />
      )}
      {mode === "edit" && canPublish && (
        <ScheduleDialog
          mode="update"
          isOpen={scheduleUpdateOpen}
          onClose={() => setScheduleUpdateOpen(false)}
          publishAt={scheduledUpdate?.update_at ?? null}
          settings={dateSettings}
          onSchedule={handleScheduleUpdate}
        />
      )}

      {canRequestReview && (
        <RequestReviewDialog
          isOpen={requestReviewOpen}
          onClose={() => setRequestReviewOpen(false)}
          meId={me?.id}
          onSubmit={handleRequestReview}
        />
      )}
      {canPublish && reviewRequest && (
        <RequestChangesDialog
          isOpen={requestChangesOpen}
          onClose={() => setRequestChangesOpen(false)}
          requesterName={reviewPersonName(reviewRequest.requested_by)}
          onSubmit={handleRequestChanges}
        />
      )}

      {/* Banners across the editor: only when you need to act or wait. */}
      {mode === "edit" && roleVerified && (
        <ReviewRequestNotice
          request={reviewRequest}
          viewer={{ id: me?.id, canReview: canPublish, canRequest: canRequestReview }}
          published={formData.post_status === "published"}
          publishable={formData.post_status !== "archived"}
          onPublish={handlePublish}
          onRequestChanges={() => setRequestChangesOpen(true)}
          onDismiss={handleDismissReview}
          onRequestAgain={() => setRequestReviewOpen(true)}
          connected={collabStatus === "connected"}
          busy={reviewBusy || isSubmitting}
        />
      )}
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
      {scheduled && scheduleFailure && (
        <Notice
          tone="danger"
          live="alert"
          inline
          className="post-editor__banner"
          title="Scheduled publish failed"
          actions={
            canPublish ? (
              <>
                <Button variant="secondary" size="sm" onClick={handlePublish} loading={isSubmitting} disabled={collabStatus !== "connected"}>
                  Publish now
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleCancelSchedule()}>
                  Cancel schedule
                </Button>
              </>
            ) : undefined
          }
        >
          {scheduleFailureMessage(scheduleFailure, dateSettings)}
        </Notice>
      )}
      {scheduled && publishAt && !scheduleFailure && (
        <Notice
          tone="info"
          live="status"
          inline
          className="post-editor__banner"
          title={`Scheduled for ${formatScheduleTime(publishAt, dateSettings, { withTime: true })}`}
          actions={
            canPublish ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)}>
                  Reschedule
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleCancelSchedule()}>
                  Cancel schedule
                </Button>
              </>
            ) : undefined
          }
        >
          {canPublish
            ? `${zoneCity(dateSettings.timeZone)} time. It goes live with its content as it is then; edits until then are included.`
            : "An editor scheduled it. It's read-only until they cancel the schedule."}
        </Notice>
      )}
      {updateScheduledId && scheduledUpdate && (
        <ScheduledUpdateNotice
          update={scheduledUpdate}
          settings={dateSettings}
          canPublish={canPublish}
          onReschedule={() => setScheduleUpdateOpen(true)}
          onCancel={() => void handleCancelScheduledUpdate()}
          onUpdateNow={handlePublish}
          connected={collabStatus === "connected"}
          isUpdating={isSubmitting}
        />
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
              <VersionPreview version={viewingVersion} postId={initialData?.id} workingKey={workingCopyKey} />
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
              {/* Their own scheduled post has its banner above (#147). */}
              {/* With Request access when they may ask (#321). */}
              {roleVerified && contentReadOnly && !(scheduled && me?.id === initialData?.user_id) && initialData?.id && (
                <ViewOnlyNotice postId={initialData.id} access={postAccess} onChanged={reloadAccess} />
              )}
              {/* The open requests, for the owner, editors and admins (#321). */}
              {roleVerified && initialData?.id && postAccess?.can_review && postAccess.pending && (
                <AccessRequestsNotice postId={initialData.id} pending={postAccess.pending} onChanged={reloadAccess} />
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
              // server just couldn't confirm access (the API is struggling; no role change),
              // nor when it refused this editor's schema (#416: only a reload helps).
              // A grant or a revoke (#321) changes the access too: re-read it with the role.
              onAccessChange={(change) => {
                if (change.revoked || change.outdated || change.reason === "unverified") return
                void authManager.refreshUser().then((user) => setMe(user ?? undefined))
                void reloadAccess()
                // Or the post changed owner (#353): a contributor who lost it keeps
                // the body read-only and must lose the details too.
                if (initialData?.id) {
                  void getPostOwner(initialData.id)
                    .then((owner) => setOwnerId(owner.id))
                    .catch(() => {
                      // The API's own checks still refuse their saves.
                    })
                }
              }}
              value={formData.content}
              title={formData.title}
              minChars={10}
              onChange={(html, text) => {
                setFormData((prev) => ({ ...prev, content: html }))
                setContentTextLen(text.trim().length)
              }}
              postId={initialData?.id}
              // The block menu's "Copy link to block" (#356): the post's public URL.
              postUrl={liveUrl}
              // Block comments (#192)
              comments={comments}
              // The settings panel's Block tab (#417)
              onEditorReady={setBlockEditor}
              onToggleBlockSettings={toggleBlockSettings}
              onOpenBlockSettings={openBlockSettings}
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
              onStored={handleStored}
              onPublishStart={() => {
                setIsSubmitting(true)
              }}
              onPublishSuccess={(result) => {
                setIsSubmitting(false)
                setFormData((prev) => ({ ...prev, post_status: "published" }))
                setPublishAt(null)
                setScheduleFailure(null)
                setScheduledUpdate(null)
                setRevisionsKey((k) => k + 1)
                // The settings went out with it (#358), and the body (#326). Re-read: someone
                // may have typed since the snapshot.
                setSettingsPending(false)
                setContentPending(false)
                void refreshSettingsState()
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

        {comments && (
          <CommentsPanel
            store={comments}
            isVisible={commentsOpen}
            onClose={() => setCommentsOpen(false)}
            sidebarWidth={sidebarWidth}
          />
        )}
        <PostSidebar
          post={currentPost}
          onUpdate={handlePostUpdate}
          isVisible={sidebarVisible && !commentsOpen}
          onToggle={() => setSidebarVisible(!sidebarVisible)}
          blockEditor={blockEditor}
          tabRequest={settingsTabRequest}
          onTabChange={(tab) => (settingsTab.current = tab)}
          sidebarWidth={sidebarWidth}
          onResize={handleSidebarResize}
          slug={formData.slug}
          mode={mode}
          onSlugChange={handleSlugChange}
          readOnly={detailsReadOnly}
          urlStructure={urlStructure}
          editAccess={
            initialData?.id && postAccess?.can_review && postAccess.collaborators?.length ? (
              <PostCollaborators postId={initialData.id} collaborators={postAccess.collaborators} onChanged={reloadAccess} />
            ) : undefined
          }
          onSettingsSaved={() => void refreshSettingsState()}
          settingsKey={settingsKey}
          settingsPending={settingsPending}
          publishAt={scheduled ? publishAt : null}
          onSchedule={collabEnabled && canPublish ? () => setScheduleOpen(true) : undefined}
          owner={
            mode === "edit" && initialData?.id
              ? {
                  me,
                  canTransfer: canTransferPost(me, { post_status: formData.post_status }),
                  onTransferred: (result) => setOwnerId(result.owner.id),
                }
              : undefined
          }
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
      {confirmFront && (
        <FrontPageConfirm
          action={confirmFront}
          title={formData.title}
          onCancel={() => setConfirmFront(null)}
          onConfirm={() => {
            const action = confirmFront
            setConfirmFront(null)
            void (action === "unpublish" ? handleUnpublish() : handleArchive())
          }}
        />
      )}
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
              users={others.map((u) => ({ id: u.id ?? -u.clientId, name: u.name ?? "Guest", src: u.avatar }))}
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

// useSyncExternalStore before the comments store exists (create mode, role not verified).
const noSubscribe = () => () => {}
const noCount = () => 0
