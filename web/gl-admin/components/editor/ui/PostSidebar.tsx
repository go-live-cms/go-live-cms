import React, { useState, useEffect } from "react"
import FeaturedImage from "./FeaturedImage"
import { useFeaturedImage } from "@gl-admin/lib/hooks/useFeaturedImage"
import type { Media, Post } from "@gl-admin/lib/api/types"
import type { PostVersion } from "@gl-admin/lib/api/blockAPI"
import RevisionsPanel from "./RevisionsPanel"
import PostTaxonomies from "./PostTaxonomies"
import PostAuthors from "./PostAuthors"
import PostOwner from "./PostOwner"
import type { TransferPostResult } from "@gl-admin/lib/api/posts"
import PostSeoPanel from "./PostSeoPanel"
import Tabs from "@gl-admin/components/ui/Tabs"
import type { PostSEOSettings } from "@gl-admin/lib/api/types"
import { EXCERPT_GUIDE, softCount } from "@gl-admin/lib/postSeo"
import { IconButton } from "@gl-admin/components/ui/Button"
import { CalendarIcon, CloseIcon } from "@gl-admin/components/ui/icons"
import { PostStatusPill } from "@gl-admin/components/ui/PostStatus"
import { useSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { formatScheduleTime, zoneCity } from "@gl-admin/lib/schedule"
import "@gl-admin/assets/styles/components/editor/post-settings.scss"

// The post settings panel (#341, "Post editor" on the redesign canvas): Post, SEO (#357)
// and History. Status changes go through the top bar's publish menu (Publish / Unpublish /
// Archive); Publish date (#147) opens the Schedule dialog for a draft or a scheduled post.
// Owner (#353) is who the post belongs to (access), with Transfer for admins; Authors
// (#319) is the byline, separate from the owner. Not built yet, so not shown: move to
// trash (#327).

type SettingsTab = "post" | "seo" | "history"

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
  // Settings (#358): called after the featured image or terms changed; `settingsKey`
  // changes when they were changed elsewhere (a restored version), to reload them;
  // `settingsPending` says a published post's settings differ from the live ones.
  onSettingsSaved?: () => void
  settingsKey?: number
  settingsPending?: boolean
  // Scheduled publishing (#147): the scheduled time, and what Publish date opens (absent
  // for users who can't schedule).
  publishAt?: string | null
  onSchedule?: () => void
  // Owner (#353): edit mode. `canTransfer` for admins (canTransferPost); called after a
  // transfer with the API's answer.
  owner?: {
    me: { id: number } | null | undefined
    canTransfer: boolean
    onTransferred?: (result: TransferPostResult) => void
  }
  // SEO (#357): edit mode. `readOnly` for anyone but editors and admins (decision 7).
  seo?: {
    value: PostSEOSettings
    onChange: (seo: PostSEOSettings) => void
    readOnly: boolean
    firstParagraph: string
    siteName: string
    siteAddress: string
    path: string
    liveTitle?: string | null
    error?: string | null
  }
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
  scheduled: "Not on the site yet. It goes live at its scheduled time.",
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
  onSettingsSaved,
  settingsKey = 0,
  settingsPending = false,
  publishAt,
  onSchedule,
  owner,
  seo,
  history,
}: PostSidebarProps) {
  const dateSettings = useSiteDateSettings()
  const [activeTab, setActiveTab] = useState<SettingsTab>("post")
  // A transfer that replaced the old owner in the byline: the Authors field reloads.
  const [bylineKey, setBylineKey] = useState(0)

  const {
    featuredImage,
    error: featuredImageError,
    setImage,
    refetch: refetchFeaturedImage,
  } = useFeaturedImage(post.id)
  const setFeaturedImage = async (media: Media | null) => {
    await setImage(media)
    onSettingsSaved?.()
  }
  // A restored version brought its own featured image (and terms, remounted below).
  useEffect(() => {
    if (settingsKey > 0) void refetchFeaturedImage()
  }, [settingsKey, refetchFeaturedImage])

  // History may go away (a demotion): fall back to the Post tab.
  useEffect(() => {
    if ((!history && activeTab === "history") || (!seo && activeTab === "seo")) setActiveTab("post")
  }, [history, seo, activeTab])

  const type = post.post_type || "post"
  const status = post.post_status || "draft"
  const currentSlug = slug ?? post.url ?? ""
  const excerptCount = softCount(post.description || "", EXCERPT_GUIDE)

  const postTab = (
    <fieldset className="post-settings__fieldset" disabled={readOnly}>
      <div className="post-settings__field">
        <span className="post-settings__label">Status</span>
        <div className="post-settings__status">
          <PostStatusPill status={status} publishAt={publishAt} />
        </div>
        <small className="post-settings__hint">{STATUS_HINT[status] ?? ""}</small>
        {status === "published" && (
          <small className="post-settings__hint" role="status">
            {settingsPending
              ? "Settings changed: the site shows the old title, excerpt, image, terms, authors and SEO until you update."
              : "The title, excerpt, image, terms, authors and SEO go live when you update. The URL changes at once."}
          </small>
        )}
      </div>

      {mode === "edit" && status !== "published" && status !== "archived" && (
        <div className="post-settings__field">
          <label htmlFor="post-publish-date" className="post-settings__label">
            Publish date
          </label>
          <button
            id="post-publish-date"
            type="button"
            className="post-settings__date"
            onClick={onSchedule}
            disabled={!onSchedule}
          >
            <CalendarIcon />
            <span>
              {status === "scheduled" && publishAt ? formatScheduleTime(publishAt, dateSettings, { withTime: true }) : "When published"}
            </span>
          </button>
          <small className="post-settings__hint">
            {status === "scheduled"
              ? `${zoneCity(dateSettings.timeZone)} time, from Settings.`
              : onSchedule
                ? "Pick a date and time to schedule it."
                : "An editor publishes it or schedules it."}
          </small>
        </div>
      )}

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

      {mode === "edit" && post.id && owner ? (
        <div className="post-settings__field">
          <span className="post-settings__label">Owner</span>
          <PostOwner
            postId={post.id}
            me={owner.me}
            canTransfer={owner.canTransfer}
            onTransferred={(result) => {
              if (result.byline_changed) {
                setBylineKey((k) => k + 1)
                // On a published post the byline change waits for Update.
                onSettingsSaved?.()
              }
              owner.onTransferred?.(result)
            }}
          />
        </div>
      ) : null}

      <div className="post-settings__field">
        <span className="post-settings__label">Authors</span>
        {mode === "edit" && post.id ? (
          <PostAuthors key={`${settingsKey}-${bylineKey}`} postId={post.id} readOnly={readOnly} onChange={onSettingsSaved} />
        ) : (
          <small className="post-settings__hint">You’re the author. Save the post first, then credit others here.</small>
        )}
      </div>

      <div className="post-settings__field">
        <span className="post-settings__label">Categories and tags</span>
        {mode === "edit" && post.id ? (
          <PostTaxonomies key={settingsKey} postId={post.id} readOnly={readOnly} onChange={onSettingsSaved} />
        ) : (
          <small className="post-settings__hint">Save the post first, then add categories and tags here.</small>
        )}
      </div>

      <div className="post-settings__field">
        <FeaturedImage value={featuredImage} onChange={setFeaturedImage} postId={post.id} disabled={!post.id || readOnly} />
        {featuredImageError && <small className="post-settings__error">{featuredImageError}</small>}
      </div>

      <div className="post-settings__field">
        <div className="post-seo__row post-seo__row--baseline">
          <label htmlFor="post-description">
            Excerpt <span className="post-settings__hint">· optional</span>
          </label>
          <span id="post-description-count" className={`post-settings__excerpt-count${excerptCount.over ? " is-over" : ""}`} aria-live="polite">
            <span className="post-seo__sr">{excerptCount.spoken}</span>
            <span aria-hidden="true">
              {excerptCount.count} / {EXCERPT_GUIDE}
            </span>
          </span>
        </div>
        <textarea
          id="post-description"
          className="post-seo__input post-seo__textarea"
          value={post.description || ""}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={3}
          maxLength={500}
          aria-describedby="post-description-hint post-description-count"
        />
        <small id="post-description-hint" className="post-settings__hint">
          Shown in lists and previews. Without one, the first paragraph is used.
        </small>
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
          onChange={(id) => setActiveTab(id as SettingsTab)}
          tabs={[
            { id: "post", label: "Post" },
            ...(seo ? [{ id: "seo", label: "SEO" }] : []),
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
        ) : activeTab === "seo" && seo ? (
          <PostSeoPanel
            seo={seo.value}
            onChange={seo.onChange}
            readOnly={seo.readOnly}
            postTitle={post.title}
            excerpt={post.description || ""}
            firstParagraph={seo.firstParagraph}
            featuredImage={featuredImage}
            siteName={seo.siteName}
            siteAddress={seo.siteAddress}
            path={seo.path}
            pending={status === "published" && settingsPending}
            liveTitle={seo.liveTitle}
            error={seo.error}
          />
        ) : (
          postTab
        )}
      </div>
    </aside>
  )
}
