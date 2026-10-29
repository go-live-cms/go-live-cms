import React, { useState, useEffect } from "react"
import FeaturedImage from "./FeaturedImage"
import { useFeaturedImage } from "@gl-admin/lib/hooks/useFeaturedImage"
import type { Post } from "@gl-admin/lib/api/types"
import type { PostVersion } from "@gl-admin/lib/api/blockAPI"
import RevisionsPanel from "./RevisionsPanel"
import PostTaxonomies from "./PostTaxonomies"
import Tabs from "@gl-admin/components/ui/Tabs"
import Textarea from "@gl-admin/components/ui/Textarea"
import { IconButton } from "@gl-admin/components/ui/Button"
import { CloseIcon } from "@gl-admin/components/ui/icons"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import "@gl-admin/assets/styles/components/editor/post-settings.scss"

// The post settings panel (#341, "Post editor" on the redesign canvas): Post and History.
// Status changes go through the top bar's publish menu (Publish / Unpublish / Archive).
// Not built yet, so not shown: the SEO tab and the excerpt guide (#357), publish date
// (#147), owner and transfer (#353), authors (#319), move to trash (#327).

interface PostSidebarProps {
  post: Post
  onUpdate: (updates: Partial<Post>) => void
  isVisible: boolean
  onToggle: () => void
  sidebarWidth: string
  onResize: (e: React.MouseEvent) => void
  slug?: string
  mode?: "create" | "edit"
  onSlugChange?: (slug: string) => void
  // Disables every field for users who can't change the post's details (#216, #135)
  readOnly?: boolean
  // "id" or "slug": how the site builds this post's address (Settings)
  urlStructure: "id" | "slug"
  // History (#136): edit mode, for users who may restore
  history?: {
    refreshKey: number
    viewingVersionNo: number | null
    onView: (version: PostVersion) => void
    onBackToWorkingCopy: () => void
  }
}

const STATUS_HINT: Record<string, string> = {
  draft: "Not on the site yet. Only people in this workspace can see it.",
  published: "On the site. Update to publish your latest changes.",
  archived: "Off the site and out of All posts. Restore it to drafts to bring it back.",
}

export default function PostSidebar({
  post,
  onUpdate,
  isVisible,
  onToggle,
  sidebarWidth,
  onResize,
  slug,
  mode = "create",
  onSlugChange,
  readOnly = false,
  urlStructure,
  history,
}: PostSidebarProps) {
  const [activeTab, setActiveTab] = useState<"post" | "history">("post")

  const {
    featuredImage,
    error: featuredImageError,
    setImage: setFeaturedImage,
  } = useFeaturedImage(post.id)

  // History may go away (a demotion): fall back to the Post tab.
  useEffect(() => {
    if (!history && activeTab === "history") setActiveTab("post")
  }, [history, activeTab])

  const type = post.post_type || "post"
  const status = post.post_status || "draft"
  const currentSlug = slug ?? post.url ?? ""

  const postTab = (
    <fieldset className="post-settings__fieldset" disabled={readOnly}>
      <div className="post-settings__field">
        <span className="post-settings__label">Status</span>
        <div className="post-settings__status">
          <PostStatus status={status} iconPath="status" />
        </div>
        <small className="post-settings__hint">{STATUS_HINT[status] ?? ""}</small>
      </div>

      <div className="post-settings__field">
        <label htmlFor="post-slug" className="post-settings__label">
          URL
        </label>
        <div className="post-settings__url">
          <span className="post-settings__url-prefix">/{type}/</span>
          <input
            type="text"
            id="post-slug"
            className="post-settings__url-input"
            name="slug"
            value={currentSlug}
            onChange={(e) => {
              onSlugChange?.(e.target.value)
              onUpdate({ url: e.target.value })
            }}
            placeholder="url-slug"
            aria-describedby="post-slug-hint"
          />
        </div>
        <small id="post-slug-hint" className="post-settings__hint">
          {urlStructure === "id"
            ? `The site uses ID addresses: /${type}/${post.id || "123"}. Change that in Settings.`
            : `Its address on the site.`}
        </small>
      </div>

      <div className="post-settings__field">
        <span className="post-settings__label">Categories and tags</span>
        {mode === "edit" && post.id ? (
          <PostTaxonomies postId={post.id} readOnly={readOnly} />
        ) : (
          <small className="post-settings__hint">Save the post first, then add categories and tags here.</small>
        )}
      </div>

      <div className="post-settings__field">
        <FeaturedImage value={featuredImage} onChange={setFeaturedImage} postId={post.id} disabled={!post.id || readOnly} />
        {featuredImageError && <small className="post-settings__error">{featuredImageError}</small>}
      </div>

      <div className="post-settings__field">
        <Textarea
          id="post-description"
          label="Excerpt"
          value={post.description || ""}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={3}
          hint="Shown in lists and previews."
        />
      </div>
    </fieldset>
  )

  return (
    <aside
      aria-label="Post settings"
      className={`post-settings ${isVisible ? "post-settings--visible" : ""}`}
      style={{ "--post-settings-width": sidebarWidth } as React.CSSProperties}
      hidden={!isVisible}
    >
      <div className="post-settings__resize-handle" onMouseDown={onResize} aria-hidden="true" />
      <div className="post-settings__header">
        <Tabs
          label="Settings sections"
          className="post-settings__tabs"
          value={activeTab}
          onChange={(id) => setActiveTab(id as "post" | "history")}
          tabs={[
            { id: "post", label: "Post" },
            ...(history ? [{ id: "history", label: "History" }] : []),
          ]}
        />
        <IconButton size="sm" aria-label="Close settings" icon={<CloseIcon />} onClick={onToggle} />
      </div>

      <div className="post-settings__content">
        {activeTab === "history" && history ? (
          <RevisionsPanel
            postId={post.id}
            refreshKey={history.refreshKey}
            viewingVersionNo={history.viewingVersionNo}
            onView={history.onView}
            onBackToWorkingCopy={history.onBackToWorkingCopy}
          />
        ) : (
          postTab
        )}
      </div>
    </aside>
  )
}
