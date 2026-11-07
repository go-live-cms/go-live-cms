import React, { useEffect, useId, useState } from "react"
import MediaPicker from "@gl-admin/components/media/MediaPicker"
import { getMediaById, getMediaSocialPreviewURL } from "@gl-admin/lib/api/media"
import type { Media, PostSEOSettings } from "@gl-admin/lib/api/types"
import {
  SEO_DESCRIPTION_GUIDE,
  SEO_TITLE_GUIDE,
  canonicalUrlError,
  cutAtWord,
  previewAddress,
  seoFallbacks,
  softCount,
  type SoftCount,
} from "@gl-admin/lib/postSeo"

// The SEO tab of the post settings panel (#357, "Post editor · SEO" on the redesign
// canvas): search preview (Desktop/Mobile), SEO title, meta description, social image
// with a shared-link preview, "Hide from search engines" and Advanced › canonical URL.
// It has no save button: PostForm saves every change (PUT /posts/:id/seo, debounced),
// and on a published post the site shows them after Update. Rules: lib/postSeo.ts.
// View-only users get read-only fields (focusable, not disabled) and an aria-disabled
// switch.

interface PostSeoPanelProps {
  seo: PostSEOSettings
  onChange: (seo: PostSEOSettings) => void
  readOnly?: boolean
  postTitle: string
  excerpt: string
  firstParagraph: string
  featuredImage: Media | null
  siteName: string
  siteAddress: string
  // The post's path on the site (/post/my-post), for the previews.
  path: string
  // A published post whose settings differ from the live ones.
  pending?: boolean
  // The live (published) title, shown under the SEO title while a change is pending.
  liveTitle?: string | null
  error?: string | null
}

function Counter({ id, count }: { id: string; count: SoftCount }) {
  return (
    <span id={id} className={`post-seo__count${count.over ? " is-over" : ""}`} aria-live="polite">
      {count.over && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 2 20h20zM12 10v4M12 17h.01" />
        </svg>
      )}
      <span className="post-seo__sr">{count.spoken}</span>
      <span aria-hidden="true">
        {count.count} / {count.guide}
      </span>
    </span>
  )
}

export default function PostSeoPanel({
  seo,
  onChange,
  readOnly = false,
  postTitle,
  excerpt,
  firstParagraph,
  featuredImage,
  siteName,
  siteAddress,
  path,
  pending = false,
  liveTitle,
  error,
}: PostSeoPanelProps) {
  const uid = useId()
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
  const [advanced, setAdvanced] = useState(!!seo.canonical_url)
  const [picking, setPicking] = useState(false)
  const [socialImage, setSocialImage] = useState<Media | null>(null)

  // The chosen social image's media row (for its preview); kept when it's the one loaded.
  useEffect(() => {
    const id = seo.social_image_id
    if (!id) {
      setSocialImage(null)
      return
    }
    if (socialImage?.id === id) return
    let cancelled = false
    getMediaById(id)
      .then(({ media }) => !cancelled && setSocialImage(media))
      .catch(() => !cancelled && setSocialImage(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seo.social_image_id])

  // A canonical URL set elsewhere (a restored version, a reload) shouldn't hide behind a
  // closed Advanced.
  const hasCanonical = !!seo.canonical_url.trim()
  useEffect(() => {
    if (hasCanonical) setAdvanced(true)
  }, [hasCanonical])

  const set = (patch: Partial<PostSEOSettings>) => {
    if (!readOnly) onChange({ ...seo, ...patch })
  }

  const fallbacks = seoFallbacks({ seo, postTitle, excerpt, firstParagraph })
  const titleCount = softCount(fallbacks.title, SEO_TITLE_GUIDE)
  const descCount = softCount(seo.seo_description.trim() ? seo.seo_description : fallbacks.description, SEO_DESCRIPTION_GUIDE)
  const descOver = !!seo.seo_description.trim() && descCount.over
  const canonError = canonicalUrlError(seo.canonical_url)
  const mobile = device === "mobile"

  const image = seo.social_image_id ? socialImage : featuredImage
  const imageKind: "custom" | "featured" | "none" = seo.social_image_id ? "custom" : featuredImage ? "featured" : "none"
  // The social crop (1200 x 630 around the focal point) when the image has one.
  const imageUrl = image ? getMediaSocialPreviewURL(image) : null
  const imageSize = image?.variants?.social ?? (image?.width && image?.height ? { width: image.width, height: image.height } : null)

  const address = previewAddress(siteAddress, path)
  const host = previewAddress(siteAddress, "")
  const ids = {
    title: `${uid}-seo-title`,
    titleHint: `${uid}-seo-title-hint`,
    titleCount: `${uid}-seo-title-count`,
    desc: `${uid}-seo-desc`,
    descHint: `${uid}-seo-desc-hint`,
    descCount: `${uid}-seo-desc-count`,
    image: `${uid}-seo-image`,
    imageHint: `${uid}-seo-image-hint`,
    hide: `${uid}-seo-hide`,
    hideNote: `${uid}-seo-hide-note`,
    adv: `${uid}-seo-advanced`,
    canon: `${uid}-seo-canon`,
    canonMsg: `${uid}-seo-canon-msg`,
  }

  return (
    <div className="post-seo">
      {readOnly && (
        <div role="note" className="post-seo__note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>
            <strong>View-only:</strong> editors and admins change the SEO settings.
          </span>
        </div>
      )}
      {error && (
        <p className="post-settings__error" role="alert">
          {error}
        </p>
      )}

      {/* 1. Search preview */}
      <div className="post-seo__section">
        <div className="post-seo__row">
          <span className="post-settings__label">Search preview</span>
          <div role="radiogroup" aria-label="Preview width" className="post-seo__segmented">
            {(["desktop", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={device === d}
                tabIndex={device === d ? 0 : -1}
                onClick={() => setDevice(d)}
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                    e.preventDefault()
                    const next = device === "desktop" ? "mobile" : "desktop"
                    setDevice(next)
                    const sibling = (e.currentTarget.parentElement?.querySelector(`[data-device="${next}"]`) as HTMLButtonElement | null)
                    sibling?.focus()
                  }
                }}
                data-device={d}
              >
                {d === "desktop" ? "Desktop" : "Mobile"}
              </button>
            ))}
          </div>
        </div>
        {pending && <span className="post-seo__pending">Preview · not published yet</span>}
        <div aria-hidden="true" className={`post-seo__serp${mobile ? " is-mobile" : ""}`}>
          <div className="post-seo__serp-site">
            <span className="post-seo__serp-icon">{(siteName || host || "?").charAt(0).toUpperCase()}</span>
            <span className="post-seo__serp-name">
              <span>{siteName || host}</span>
              <span className="post-seo__serp-url">{address}</span>
            </span>
          </div>
          <span className="post-seo__serp-title">{cutAtWord(fallbacks.title || "Untitled", mobile ? 70 : SEO_TITLE_GUIDE)}</span>
          {fallbacks.description && (
            <span className="post-seo__serp-desc">{cutAtWord(fallbacks.description, mobile ? 120 : 155)}</span>
          )}
        </div>
      </div>

      {/* 2. SEO title */}
      <div className="post-settings__field">
        <div className="post-seo__row post-seo__row--baseline">
          <label htmlFor={ids.title}>SEO title</label>
          <Counter id={ids.titleCount} count={titleCount} />
        </div>
        <input
          id={ids.title}
          type="text"
          className={`post-seo__input${titleCount.over ? " is-over" : ""}`}
          value={seo.seo_title}
          placeholder={postTitle}
          readOnly={readOnly}
          maxLength={255}
          onChange={(e) => set({ seo_title: e.target.value.replace(/\s*\n\s*/g, " ") })}
          aria-describedby={`${ids.titleHint} ${ids.titleCount}`}
        />
        <small id={ids.titleHint} className="post-settings__hint">
          {fallbacks.titleHint}
        </small>
        {pending && liveTitle && liveTitle !== fallbacks.title && (
          <small className="post-settings__hint">
            <span className="post-seo__live">Live:</span> {liveTitle}
          </small>
        )}
      </div>

      {/* 3. Meta description */}
      <div className="post-settings__field">
        <div className="post-seo__row post-seo__row--baseline">
          <label htmlFor={ids.desc}>Meta description</label>
          <Counter id={ids.descCount} count={{ ...descCount, over: descOver }} />
        </div>
        <textarea
          id={ids.desc}
          rows={3}
          className={`post-seo__input post-seo__textarea${descOver ? " is-over" : ""}`}
          value={seo.seo_description}
          placeholder={fallbacks.descriptionPlaceholder}
          readOnly={readOnly}
          maxLength={500}
          onChange={(e) => set({ seo_description: e.target.value })}
          aria-describedby={`${ids.descHint} ${ids.descCount}`}
        />
        <small id={ids.descHint} className="post-settings__hint">
          {fallbacks.descriptionHint}
        </small>
      </div>

      {/* 4. Social image */}
      <div className="post-settings__field">
        <span id={ids.image} className="post-settings__label">
          Social image
        </span>
        {imageKind === "none" ? (
          <>
            <button
              type="button"
              className="post-seo__drop"
              onClick={() => !readOnly && setPicking(true)}
              aria-labelledby={ids.image}
              aria-describedby={ids.imageHint}
              aria-disabled={readOnly || undefined}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 15V3M7 8l5-5 5 5" />
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              </svg>
              <span>
                Choose from <span className="post-seo__link">media</span>
              </span>
            </button>
            <small id={ids.imageHint} className="post-settings__hint">
              No social image or featured image yet. Shared links show text only. 1200 × 630 works best.
            </small>
          </>
        ) : (
          <>
            <div className="post-seo__image">
              {imageUrl && <img src={imageUrl} alt={image?.alt || ""} />}
            </div>
            <div className="post-seo__row">
              <span className="post-settings__hint post-seo__image-name">
                {imageKind === "featured"
                  ? "Uses the featured image"
                  : `${socialImage?.name || socialImage?.original_filename || "Image"}${imageSize ? ` · ${imageSize.width} × ${imageSize.height}` : ""}`}
              </span>
              {!readOnly && (
                <span className="post-seo__actions">
                  <button type="button" className="post-seo__button" onClick={() => setPicking(true)}>
                    Change
                  </button>
                  {imageKind === "custom" && (
                    <button type="button" className="post-seo__button post-seo__button--danger" onClick={() => set({ social_image_id: null })}>
                      Remove
                    </button>
                  )}
                </span>
              )}
            </div>
          </>
        )}

        <span className="post-settings__hint post-seo__share-label">Shared link preview</span>
        <div aria-hidden="true" className="post-seo__card">
          {imageUrl && <img src={imageUrl} alt="" />}
          <div className={`post-seo__card-text${imageUrl ? "" : " no-image"}`}>
            <span className="post-seo__card-host">{host}</span>
            <span className="post-seo__card-title">{cutAtWord(fallbacks.title || "Untitled", 70)}</span>
            {fallbacks.description && <span className="post-seo__card-desc">{cutAtWord(fallbacks.description, 100)}</span>}
          </div>
        </div>
      </div>

      <div className="post-seo__divider" />

      {/* 5. Hide from search engines */}
      <div className="post-settings__field">
        <div className="post-seo__row">
          <span id={`${ids.hide}-label`} className="post-settings__label">
            Hide from search engines
          </span>
          <button
            type="button"
            role="switch"
            id={ids.hide}
            className="gl-switch"
            aria-checked={seo.noindex}
            aria-labelledby={`${ids.hide}-label`}
            aria-describedby={seo.noindex ? ids.hideNote : undefined}
            aria-disabled={readOnly || undefined}
            onClick={() => set({ noindex: !seo.noindex })}
          >
            <span className="gl-switch__knob" aria-hidden="true" />
          </button>
        </div>
        {seo.noindex && (
          <div id={ids.hideNote} className="post-seo__warning">
            Search engines won’t list this post, and it’s left out of the sitemap.
          </div>
        )}
      </div>

      {/* 6. Advanced */}
      <div className="post-settings__field">
        <button
          type="button"
          className="post-seo__disclosure"
          aria-expanded={advanced}
          aria-controls={ids.adv}
          onClick={() => setAdvanced((open) => !open)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
          Advanced
        </button>
        {advanced && (
          <div id={ids.adv} className="post-settings__field">
            <label htmlFor={ids.canon}>Canonical URL</label>
            <input
              id={ids.canon}
              type="url"
              inputMode="url"
              className={`post-seo__input post-seo__mono${canonError ? " is-invalid" : ""}`}
              value={seo.canonical_url}
              placeholder="https://"
              readOnly={readOnly}
              maxLength={2048}
              onChange={(e) => set({ canonical_url: e.target.value })}
              aria-invalid={canonError ? true : undefined}
              aria-describedby={ids.canonMsg}
            />
            {canonError ? (
              <span id={ids.canonMsg} className="post-settings__error">
                {canonError}
              </span>
            ) : (
              <small id={ids.canonMsg} className="post-settings__hint">
                {seo.canonical_url.trim()
                  ? "Search engines treat this address as the original. Use it when the post also appears elsewhere."
                  : "Leave empty to use this post’s own address."}
              </small>
            )}
          </div>
        )}
      </div>

      <MediaPicker
        isOpen={picking}
        onClose={() => setPicking(false)}
        kind="image"
        title="Choose a social image"
        removeLabel="Use the featured image"
        current={socialImage}
        onSelect={(media) => {
          setSocialImage(media)
          set({ social_image_id: media?.id ?? null })
          setPicking(false)
        }}
      />
    </div>
  )
}
