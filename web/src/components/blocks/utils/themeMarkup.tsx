import React from "react"
import type { Post } from "@gl-admin/lib/api/types"
import { avatarColor, bylinePeople, initial, nameSeparator, type BylinePerson } from "../../../lib/bylines"
import { pageLinks, pagePath, pageWindow } from "../../../lib/pagination"
import { DEFAULT_DATE_SETTINGS, formatSiteDate, type DateSettings } from "../../../lib/siteDates"
import { MAX_QUERY_LENGTH, SEARCH_PATH } from "../../../lib/searchPath"

/**
 * The default theme's small pieces that several site blocks render (#498), each **the markup of
 * the theme component it stands for**, so a block template and the theme's code layouts give the
 * same HTML (`themes/default/siteBlocksMarkup.astro.test.ts` compares them):
 *
 * - `ThemeChoices`: `ThemeSwitch.astro` (Light, Dark, System; `theme-init.js` drives them).
 * - `SearchFormMarkup`: `SearchForm.astro` (a plain GET to /search).
 * - `PagerMarkup`: `src/components/Pagination.astro` (#349's pager).
 * - `ThemeByline`: `PostByline.astro` (avatars, names, the date, the reading time).
 *
 * Browser-safe and data-free: the blocks pass what they read from the `SiteRenderContext`.
 */

const SCHEME_CHOICES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const

/** `ThemeSwitch.astro`: the three choices, `aria-pressed` kept in step by the theme's script. */
export function ThemeChoices({ variant }: { variant: "segmented" | "menu" }) {
  return (
    <div className={`theme-choices theme-choices--${variant}`}>
      {SCHEME_CHOICES.map((choice) => (
        <button key={choice.value} type="button" className="theme-choice" data-theme-choice={choice.value} aria-pressed="false">
          {choice.label}
        </button>
      ))}
    </div>
  )
}

/** The magnifier the header's search link and the compact form's button draw. */
export function SearchIcon({ size = 20 }: { size?: 18 | 20 }) {
  return size === 18 ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <path d="m20 20-3.5-3.5"></path>
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <path d="m20 20-3.5-3.5"></path>
    </svg>
  )
}

/** `SearchForm.astro`: the field (prefilled with `value`) and its button, a GET to /search that works without JavaScript. */
export function SearchFormMarkup({
  id,
  label,
  value = "",
  placeholder = "Search the blog",
  button = "Search",
  compact = false,
  className,
  anchorId,
}: {
  id: string
  label: string
  value?: string
  placeholder?: string
  button?: string
  compact?: boolean
  /** Extra classes (the search block's `search-block`). */
  className?: string
  anchorId?: string
}) {
  const classes = ["search-form", compact && "search-form--compact", className].filter(Boolean).join(" ")
  return (
    <form id={anchorId} role="search" className={classes} action={SEARCH_PATH} method="get">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        name="q"
        className="input"
        defaultValue={value}
        placeholder={placeholder}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        enterKeyHint="search"
      />
      {compact ? (
        <button type="submit" className="btn btn-primary" aria-label={button}>
          <SearchIcon size={18} />
        </button>
      ) : (
        <button type="submit" className="btn btn-primary">
          {button}
        </button>
      )}
    </form>
  )
}

/**
 * `Pagination.astro` (#349): "← Newer · 1 2 3 … 5 · Page 1 of 5 · Older →"; nothing for one page.
 * The arrows are hidden from screen readers, every number is named "Page N".
 */
export function PagerMarkup({
  page,
  totalPages,
  basePath,
  query = "",
  previousLabel = "Newer",
  nextLabel = "Older",
  anchorId,
}: {
  page: number
  totalPages: number
  basePath: string
  query?: string
  previousLabel?: string
  nextLabel?: string
  anchorId?: string
}) {
  if (totalPages <= 1) return null
  const links = pageLinks(basePath, page, totalPages)
  const withQuery = (href: string) => `${href}${query}`
  return (
    <nav id={anchorId} className="pagination" aria-label="Pages">
      {links.newer ? (
        <a href={withQuery(links.newer)} className="page-link" rel="prev">
          <span aria-hidden="true">←</span>
          {` ${previousLabel}`}
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          {`← ${previousLabel}`}
        </span>
      )}
      {pageWindow(page, totalPages).map((slot, i) =>
        slot === "gap" ? (
          <span key={`gap-${i}`} className="page-link page-num" aria-hidden="true">
            …
          </span>
        ) : (
          <a key={slot} href={withQuery(pagePath(basePath, slot))} className="page-link page-num" aria-label={`Page ${slot}`} aria-current={slot === page ? "page" : undefined}>
            {slot}
          </a>
        ),
      )}
      <span className="page-status">{`Page ${page} of ${totalPages}`}</span>
      {links.older ? (
        <a href={withQuery(links.older)} className="page-link" rel="next">
          {`${nextLabel} `}
          <span aria-hidden="true">→</span>
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          {`${nextLabel} →`}
        </span>
      )}
    </nav>
  )
}

function Avatar({ person, size }: { person: BylinePerson; size: number }) {
  return (
    <span className="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px`, background: avatarColor(person.key) }}>
      {person.avatar ? <img src={person.avatar} alt="" width={size} height={size} loading="lazy" decoding="async" /> : initial(person.name)}
    </span>
  )
}

function Names({ people }: { people: BylinePerson[] }) {
  return (
    <>
      {people.map((p, i) => (
        <React.Fragment key={p.key + i}>
          {nameSeparator(i, people.length)}
          {p.href ? <a href={p.href}>{p.name}</a> : p.name}
        </React.Fragment>
      ))}
    </>
  )
}

/**
 * `PostByline.astro`: on the page (`post`), "By <names>" over the long date and the reading time;
 * in a list, the names, the short date and the reading time on one line. `credited` are the post's
 * credited authors (the route's, else the row's byline); the owner without them, unlinked. The date
 * and the reading time are shown only when asked for (`date`, `minutes`), the avatars unless not.
 */
export function ThemeByline({
  post,
  credited,
  variant,
  avatars = true,
  date = true,
  minutes = null,
  dates = DEFAULT_DATE_SETTINGS,
  anchorId,
}: {
  post: Post
  credited?: Parameters<typeof bylinePeople>[0]
  variant: "post" | "list"
  avatars?: boolean
  date?: boolean
  minutes?: number | null
  dates?: DateSettings
  anchorId?: string
}) {
  const people = bylinePeople(credited?.length ? credited : post.authors, post)
  const published = new Date(post.created_at)
  const time = date && !Number.isNaN(published.getTime()) ? <time dateTime={published.toISOString()}>{formatSiteDate(published, dates, variant === "post" ? "long" : "short")}</time> : null
  const size = variant === "post" ? 36 : 28
  // The reading time follows the date, or (without one) the names; on its own it has no separator.
  const reading = (after: boolean) => (minutes ? `${after ? " · " : ""}${minutes} min read` : null)
  return (
    <div id={anchorId} className={`byline meta byline--${variant}`}>
      {avatars && (
        <span className="avatars" aria-hidden="true">
          {people.slice(0, 3).map((p, i) => (
            <Avatar key={p.key + i} person={p} size={size} />
          ))}
        </span>
      )}
      {variant === "post" ? (
        <span className="byline-text">
          {people.length > 0 && (
            <span>
              {"By "}
              <Names people={people} />
            </span>
          )}
          {(time || minutes) && (
            <span>
              {time}
              {reading(!!time)}
            </span>
          )}
        </span>
      ) : (
        <span>
          <Names people={people} />
          {time && (
            <>
              {people.length > 0 && " · "}
              {time}
            </>
          )}
          {reading(people.length > 0 || !!time)}
        </span>
      )}
    </div>
  )
}
