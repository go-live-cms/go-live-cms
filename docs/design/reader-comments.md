# Reader comments on published posts (#499)

Status: **design, for review**, 2026-11. No code ships with this document. Section 18 lists
the questions that need an answer before the sub-issues in section 17 are filed.

Builds on: `docs/design/theme-builder.md` (#475: decision 9 in section 16, the site blocks of
section 4, caching in section 11; the comments block is its T18, #500) and
`docs/design/plugin-system.md` (#432: the outbox in 7.2 to 7.6, guards in 7.7, webhooks in
7.9). Read with `api/CLAUDE.md` (open signup, rate limits, mail, request hardening, users),
`web/CLAUDE.md` (page caching, the API proxy, account pages, block comments) and
`docs/operations/backups.md`. Related issues: #192 (editorial block comments), #191 (open
signup), #190 (rate limits), #324 (activity), #148 (mail), #327 (trash), #185 (caching), #320
(mentions), #358 (publish snapshot), #458 and #459 (plugin hooks and guards), #460
(webhooks), #500 (the comments site block).

## Summary

Readers can't comment on the public site today. #192's comments are editorial: they sit on
a post's blocks in the admin and never reach `/public`. This document designs reader
comments, the public discussion under a published post:

1. **A reader is a verified email, not an account.** A reader comments with a name, an
   email and the text. The first comment from a browser is confirmed by a link mailed to
   that address. Confirming marks the address verified and gives that browser a key, so its
   later comments need no mail. Reader accounts through open signup are **not** in v1:
   signup creates contributors, who are admin users, and the public site has no sessions
   (section 3).
2. **Staff reply from the admin.** Admins and editors reply from the moderation screen as
   themselves, with a badge ("Author" when they are on the post's byline, else "Staff").
   No public-site sign-in is needed for that.
3. **Moderated by default, with rules.** A comment is **held** until its commenter has one
   approved comment (the default; "hold all" and "hold none" are the other modes), or when
   it trips a rule: too many links, a held word, a name that matches a member's, or a
   plugin's guard. Spam words send it straight to Spam. Admins and editors moderate
   (section 4).
4. **Spam is fought in layers, with no CAPTCHA in core:** the email confirmation itself,
   per-IP and per-address rate limits, a honeypot field, link limits, word lists, and a
   comment guard for plugins (an Akismet-style checker or a CAPTCHA plugin), on #459's
   pattern (section 5).
5. **Own tables, not #192's.** `reader_comments` and `commenters` are new tables. Two
   levels are shown (a comment and its replies), plain text only, no editing by readers in
   v1, and soft states (`pending`, `approved`, `spam`, `trash`) with a tombstone for a
   removed comment that has replies. A trashed or unpublished post hides its thread and
   keeps it, and a post deleted for good deletes it (section 6).
6. **Emails are never public, IPs are never stored.** No `/public` response, log line,
   activity entry or plugin event carries an email. An IP becomes a keyed hash kept 30 days,
   enough to say "3 other comments from this network" (section 7).
7. **Mail is opt-in and unsubscribable.** Readers get the confirmation, and replies only if
   they tick "Email me replies". Authors and moderators choose on Profile. Every reader mail
   has a one-click unsubscribe and a "manage your comments" link. Confirmation mails never
   contain anything the sender typed, so the form can't be used to mail spam (section 8).
8. **The API gains its first anonymous writes outside `/auth`,** under `/public`, which
   browsers can't reach: the site posts its form to its own Astro endpoint, which calls them.
   So the form works without JavaScript, `gl-comments.js` enhances it, and every write is
   rate-limited and listed in a new audit of anonymous POSTs (section 9).
9. **Pages stay cacheable.** Nothing on a post page depends on who is reading. The thread is
   a cached `/public` read like the others, purged (globally, as #185 does today) when a
   change reaches what readers see. The cached answer carries the close date, not a state
   computed from the clock (section 10).
10. **One renderer, two entry points.** A core `PostComments` component renders the thread
    and form for code layouts. The comments site block (#500) renders the same markup from
    the site render context, so T17's parity check holds (section 11).
11. **Settings at three levels:** a site master switch (off by default) with moderation and
    display settings in **Settings › Discussion**, a **Comments** field per post type (on
    for Posts), and a per-post **Discussion** choice (default, open, closed, off) that
    applies at once, outside the publish snapshot. "Close after N days" counts from first
    publish (section 12).
12. **Export and erasure for readers,** self-service by email link and by an admin from the
    commenter's page (section 13).
13. **Plugins see comment events** through the existing outbox (`comment.created`,
    `comment.approved`, …, ids only), and a declared `comment.before_create` guard can hold
    or spam a comment, never approve one (section 14).

The phased plan is section 17. Section 18 holds the decisions this design proposes and the
questions that need an answer.

---

## 1. Where things stand

- **Editorial comments (#192)** are `post_comment_threads` and `post_comments`
  (`000048_post_comments`), anchored to a block id, read and written through
  `GET/POST/PUT/DELETE /posts/:id/comments` by anyone who may read the working copy
  (`posts_routes.go`). They are never in the Yjs doc, never in `/public`, and the admin labels
  them "Comments" in the editor's top bar and panel.
- **Open signup (#191)** is off by default (`settings.allow_signup`). A confirmed signup
  becomes a user with `db.SignupRole`, **contributor, fixed**: a member of the admin who can
  write drafts. There is no reader role. The sign-in, register and verify pages are account
  pages (`AccountPage.astro`, the admin's styles).
- **The public site has no reader sessions.** It renders server-side from `/public`. The only
  session cookies are the admin's refresh cookie and the legacy `auth_token`, and a page
  request carrying either is `private, no-store` (`web/src/lib/httpCache.ts`).
- **Page caching (#185).** Post and page URLs are `public, max-age=60,
  stale-while-revalidate=300` for anonymous visitors; anything that sets a cookie is
  `no-store`. The API caches every `/public` read except search and redirects in Valkey
  (`api/public_cache.go`: 5 minutes, anonymous requests only, keyed by path and query) and
  purges **all of it at once** (a new generation) after any write listed in
  `publicCachePurgeRoutes`. Every mutating route must be listed there or in
  `publicCacheNoPurgeRoutes` (`TestMutatingRoutesDeclarePublicCachePurge`), and a cached
  route must not read headers, cookies or the clock.
- **`/public` is server-side only.** It sits at `/public`, not under `/api/v1`, and the web's
  production proxy (`web/src/middleware/apiProxy.ts`) forwards only `/api/v1` and `/uploads`.
  There is **no POST under `/public` today**: the only anonymous writes are `/api/v1/auth/*`.
  `route_auth_test.go` audits GETs (`publicGETRoutes`) and has no audit of anonymous POSTs.
- **Client addresses.** The proxy appends the browser's address to `X-Forwarded-For`. The
  API reads it only from `TRUSTED_PROXIES`, which in prod `compose.yaml` lists the web
  container, and `RATE_LIMIT_EXEMPT_CIDRS` exempts the web container from the general limit
  (its SSR reads carry no client address).
- **Rate limits (#190)** are per minute from `RATE_LIMIT_*`, in memory behind
  `RateLimitStore`, keyed by `clientKey` (IPv6 by /64). A general per-IP limit covers `/public`.
  Signup adds a per-IP limit, a per IP+address limit, and a silent one-mail-a-minute cooldown
  per address (`allowSilently`). Per-address-only keys are forbidden: they let anyone lock an
  owner out.
- **Mail (#148)** is `mailer/` (`smtp`, `file`, `log`), text and HTML templates in
  `mailer/templates/`, links from `PUBLIC_BASE_URL`, sent by `sendMail` (30s timeout) from
  `runInBackground` after the response: no outbox, no retry, and no unsubscribe anywhere
  (every mail today goes to a member). Tokens are 32 random bytes, stored as SHA-256, put in
  a link's `#fragment`, and spent by a page's button, never on load (a mail scanner can't
  spend them). `post_reminders` (#320) is the one claimed, retried mail queue, inside the
  scheduler loop.
- **Mentions (#320)** mail a member once per post, always on: there is no notifications
  table, no digest and no per-member preference yet.
- **Activity (#324)** is append-only, ids and non-personal details only (never names,
  emails, IPs or content), `verb` and `object_type` matching `^[a-z][a-z_]{0,39}$`, kept
  `ACTIVITY_RETENTION` (90 days). Admins read everything; editors read post and media events;
  **any other object type is admin-only** (`db/query/activity.sql`).
- **Trash (#327)** is `post_status = 'trash'` with `trashed_from_status`; restore puts the old
  status back; delete permanently (editors and admins) removes the row and cascades. There is
  **no auto-empty**.
- **Post types** have `supports` (jsonb, e.g. `["title","content","description","author",
  "taxonomies","media"]` for `post`). The Post types screen lists them as "Fields", and Posts
  and Pages are read-only there.
- **Plugin events (#458)** are rows in `plugin_events` (`post_id NOT NULL`, no FK) written by
  a trigger on `posts` and fanned out by `RunPluginHooks`. Publish guards (#459) run before
  the transaction and answer `plugin_refused`.
- **Site blocks (#488, #489)** render only from a `SiteRenderContext`. `comments` was left
  for this design (theme-builder 4.1, T18).

### 1.1 Two things called "comment"

| | What it is | Who sees it | Where |
|---|---|---|---|
| **Block comment** (#192) | An editorial note on a block of the working copy | Members who can read the post | `post_comments`, `/posts/:id/comments`, the editor |
| **Reader comment** (#499) | Public discussion under a published post | Everyone, once approved | `reader_comments`, `/public/posts/:id/comments`, `/discussion/*` |

**Decision:** in code and SQL they are **reader comments** (`reader_comments`, `commenters`,
`discussion` for settings and admin routes). #192 already owns `db.PostComment`,
`CommentResponse`, `commentBodyMax`, `lib/comments.ts` and the activity verbs `commented` and
`comment_*`, so every new name says `ReaderComment`, `reader_comment` or `discussion`. The
admin calls the moderation screen
**Discussion** (WordPress's name for the same settings), so "Comments" in the editor keeps
meaning #192's. The public site says "Comments", since readers never see #192's. Open
question 4.

### 1.2 Problems found while writing this

| # | Problem | Where | Consequence |
|---|---|---|---|
| 1 | Open signup makes contributors, who can write drafts and see published posts' working copies. | `db.SignupRole` | Signup can't be the reader identity without a new role and a public-site session. Section 3. |
| 2 | `/posts/:id/comments` is #192's. | `posts_routes.go` | Admin routes for reader comments go under `/discussion`. Section 9.3. |
| 3 | A form that mails a confirmation to any typed address is a mail cannon: an attacker types a victim's address and our server mails them. | the write path | The confirmation carries nothing the sender typed, and the address gets a silent cooldown. Sections 5, 8. |
| 4 | Posts and Pages are read-only on the Post types screen. | `lib/postTypes.ts` | Their **Comments** field must be editable on its own. Section 12.2. |
| 5 | The page cache keys on session cookies only. | `httpCache.ts` | A reader's own cookie must not be sent with page requests, or nothing personal can show. The browser key is path-scoped to the write endpoint. Section 3.3. |
| 6 | There is no mail outbox. `runInBackground` loses a mail on a crash and can't coalesce. | `mailer/` | Notifications get a small outbox; the confirmation keeps the signup pattern. Section 8.4. |
| 7 | `plugin_events.post_id` is NOT NULL. | `000055` | Fine: every comment belongs to a post. Comment events carry it, and per (plugin, post) ordering then covers a thread. Section 14. |
| 8 | A cached `/public` route may not read the clock, but "close after N days" is a time. | `public_cache.go` | The cached answers carry the setting and `closes_at`; the renderer and the write path apply the time (9.1, 12.4). |
| 9 | The public cache purges everything at once. | `public_cache.go` | Each moderation action that changes what readers see purges the whole public cache. Acceptable at a moderator's pace; a per-post namespace is a later optimization (section 10). |
| 10 | Activity of an object type other than post or media is admin-only. | `activity.sql` | Editors moderate, so the visibility query gains the comment types for editors (15.2). |
| 11 | No test audits anonymous POSTs. | `route_auth_test.go` | The new writes get a `publicPOSTRoutes` audit, as GETs have (15.1). |

---

## 2. Scope

**In:** guests commenting with a verified email; staff replies from the admin; moderation
(queue, rules, bulk actions); spam and abuse defences; storage, threading, deletion and the
post's lifecycle; privacy; notifications; the public API; caching; rendering for code themes
and the comments site block; site, type and post settings; export and erasure; plugin events
and a guard; admin and public screens (drawn on the canvases, section 16).

**Not in this design:**

- **Reader accounts.** Signing in on the public site, profiles, "my comments" across
  browsers. Open question 1; section 3.1 says what they would need.
- **Reader edits.** A reader deletes a comment and writes it again (open question 5).
- **Rich text, images, Markdown and embeds in comments.** Plain text with links.
- **Reactions, votes, sorting by popularity, pinned comments.**
- **Mentions (#320) in reader comments.** `@name` is plain text: letting any reader mail a
  member is an abuse channel.
- **Comment feeds (RSS), comments in site search, comment counts on lists** (open question
  11).
- **Comments on anything but posts of a public type** (not on templates, media or terms).
- **Importing comments** from WordPress or Disqus. The storage allows it later (section 6.1
  keeps `created_at` writable for an importer).
- **A third-party commenting service** (Disqus, Giscus). It puts readers' data and a script
  of someone else's on every post, against this CMS's no-third-party default.

---

## 3. Who may comment, and identity

### 3.1 Options

| | A. **Guests with a verified email** (recommended for v1) | B. Signed-in readers only | C. Guests without verification (WordPress) | D. Both A and B |
|---|---|---|---|---|
| Identity | A confirmed address, remembered per browser | A user account with a new `reader` role | A typed name and email, unchecked | Either |
| Friction | One mail per browser, then none | Sign up, confirm, sign in | None | Reader's choice |
| Needs | `commenters`, a browser key, one mail | A role that can't enter the admin; reader sessions on the public site (cookies, CSRF, refresh, sign-in UI in every theme); per-visitor pages, so post pages stop being cacheable for them | Nothing | All of A and B |
| Impersonation | Hard: typing someone's address gets a mail to them, not a comment | Hard | **Easy**: anyone typing a trusted reader's address is auto-approved as them | Hard |
| Spam | The mail step stops most bots | Signup's own defences | The worst | As A |
| Verdict | **Use** | Later, if wanted | Rejected | Later |

B is the bigger change and mostly not about comments: a reader role, public-site sessions,
and a decision about what a signed-in reader sees (#191 decided signups are contributors).
Every page a signed-in reader views would become `no-store` under today's cache rule. A
keeps post pages identical for everyone, which is what lets them stay cached (section 10).
A's storage leaves room for B: a commenter row can later point at a user.

### 3.2 The commenter

A **commenter** is one email address on this site: lower-cased and trimmed for matching,
shown nowhere public. It holds a `verified_at`, a display name (the last one used), and
counts used by moderation (approved comments). A reader who uses two addresses is two
commenters; one address used under two names is one commenter whose latest name shows on new
comments. Each comment keeps the name it was posted with, so changing it later doesn't rename
old comments.

### 3.3 Confirming, and the browser key

1. A reader submits name, email and text. The API looks for a **browser key** sent with the
   request (below). Without a valid key for that address, the comment is stored as
   `unconfirmed` and the address gets a **"Confirm your comment"** mail. The answer is the
   same "Check your email to publish your comment" whether or not the address is known,
   verified or in its cooldown, as signup does.
2. The link is `PUBLIC_BASE_URL/comments/confirm#token=…`. The page confirms on its button,
   never on load (#191's rule). Confirming moves the comment to `pending` or `approved`
   (section 4), stamps `verified_at`, and sets a browser key on the browser that confirmed.
3. A **browser key** is 32 random bytes in a cookie, `gl_commenter`, stored as SHA-256 in
   `commenter_keys` with its commenter, `HttpOnly`, `Secure`, `SameSite=Lax`, one year, and
   **`Path=/gl-comments`**: it reaches the write endpoint only, never a page, so pages stay
   identical for everyone and cacheable (problem 5). A comment sent with a valid key for its
   address skips the mail. The key is per commenter: a browser can hold keys for several
   addresses (one cookie value lists them, at most 5).
4. Unconfirmed comments expire after **48 hours** (pruned hourly, like
   `RunSignupRequestPrune`). A second unconfirmed comment from the same address within the
   cooldown is stored but sends no second mail.
5. **A link confirms its own comment only.** Anyone can type any address, so the other
   unconfirmed comments of that address may be someone else's, written to pass as its owner.
   After confirming, the page lists the address's other unconfirmed comments (post title and
   their first 100 characters, shown only to the person holding the link) with **Publish** or
   **Discard** on each, none chosen for them. A reader whose second comment fell in the
   cooldown confirms it there; a forged one is discarded or left to expire.

The confirming browser may not be the one that wrote the comment (a phone's mail app). Then
the phone holds the key, and the desktop's next comment asks again. That's the price of not
having accounts, and it is rare after the first time.

**"Remember me" is the key.** The form has no checkbox for it: a reader who doesn't want it
clears their cookies, and the privacy notice under the form says what the cookie is (12.1).

### 3.4 Staff comments

Members don't use the public form as themselves (they could, as guests, like anyone). They
reply, or start a comment, from **Discussion** in the admin. Such a comment is stored with
`author_user_id`, is approved at once (they are moderators), and shows the member's current
name and avatar (`safeAvatarSrc`) with a badge: **Author** when the member is on the post's
**published** byline, else **Staff**. A removed member's comments keep the name they were
posted with and lose the badge (`author_user_id` → NULL).

A guest name that equals a member's full name or username (case-insensitive, accents
dropped) is held with the reason "Name matches a member" (4.2), so a reader can't pass as
staff on an unmoderated site.

### 3.5 Names and avatars

- **Name:** 1 to 60 characters after trimming, no control characters, shown as text.
- **No website field.** It is the main reason spam is posted at all, and the issue has no
  use for it.
- **No Gravatar.** It would send an email hash to a third party on every page view and
  publish a hash that can be matched against known addresses. A reader's avatar is their
  initial on a colour keyed by commenter id, as presence colours are keyed today.

---

## 4. Moderation

### 4.1 Statuses

| Status | Shown publicly | Counts | Set by |
|---|---|---|---|
| `unconfirmed` | No | No | the write path, without a browser key |
| `pending` | No | No | confirmation or a key, when a rule holds it |
| `approved` | **Yes** | Yes | the rules, or a moderator |
| `spam` | No | No | a spam word, a guard, or a moderator |
| `trash` | No | No | a moderator; keeps `trashed_from` for restore |

Moving a comment to `pending` from `approved` is **Unapprove**. Marking spam and "Not spam"
(back to `pending`) are recorded, so a commenter whose comment was marked spam is held
afterwards whatever the mode.

### 4.2 Approval rules

| | A. Hold everything | B. **Hold until a commenter is approved once** (recommended default) | C. Publish everything, moderate after |
|---|---|---|---|
| Spam reaching the page | None | Only from a commenter a moderator approved before | All that passes the filters |
| Moderator load | Every comment | First comments | Reports and cleanup |
| Conversation speed | Slow | Fast for regulars | Fast |
| Verdict | A setting | **Default** | A setting |

The mode is `comments_moderation`: `all`, `first` (default) or `none`. Whatever the mode,
these hold a comment as `pending`, each with a reason the queue shows:

| Reason (`held_reason`) | Rule |
|---|---|
| `first_comment` | mode `first` and the commenter has no approved comment |
| `moderation_all` | mode `all` |
| `links` | more links than `comments_max_links` (default 1; a link is anything the renderer would link, 11.4) |
| `held_word` | the text or name contains a word from `comments_hold_words` |
| `member_name` | 3.4 |
| `previous_spam` | the commenter had a comment marked spam in the last 90 days (`commenters.last_spam_at`, since the spam rows themselves go after 30) |
| `plugin` | a guard answered hold (14.2), with its reason |

And these send it to `spam`: a word from `comments_spam_words`, the honeypot (5.2), a guard
answering spam. A spam word beats a hold word.

Word lists are one entry per line, at most 500 entries of at most 64 characters, matched
case-insensitively on word boundaries after accents are dropped (one rule in Go, vectors for
the admin's preview).

### 4.3 Who moderates

| Role | In Discussion |
|---|---|
| Admin | Everything, the settings, commenters, export and erasure |
| Editor | Moderate and reply on every post; commenters' pages; no settings, no erasure |
| Contributor | **No access in v1** (assumed, open question 3) |

`canModeratePosts` (editors and admins) gates every `/discussion` route; settings and erasure
are `requireSiteAdmin`. A contributor approving a comment would put reader text on the site
without an editor, which contributors can't do with their own text either.

### 4.4 The queue

**Discussion** in the sidebar (under Content, after Media, with the pending count) opens on
the **Pending** tab: newest first, each row with the commenter's initial, name, email (13.4
on who sees it), "New commenter" for one with nothing approved, the held reason, the text
(first 300 characters, expandable), the post's title (link to the public URL and to the
editor), the time, and **Approve**, **Spam**, **Trash** and **Reply**. Other tabs: Approved,
Spam, Trash, each with a count from `GET /discussion/counts`. Filters: post, commenter, text
search. Rows are selectable, with bulk Approve, Spam, Not spam, Trash, Restore and Delete
permanently (the last asks first), answering per comment as `POST /posts/bulk` does.

A comment opens a **drawer** with its whole thread (parent and replies, every status, the
held ones marked), a reply box ("Reply as Ana Costa"; approving the comment first if it is
pending, since a reply under a hidden comment would show alone), and the commenter's summary:
approved, pending and spam counts, "3 other commenters from this network" (7.2), and links to
their page.

Comments on a post that isn't published (draft, archived, trash) stay in the queue, marked
"Post not published", since approving them is still meaningful when it comes back. Home's
**Needs attention** gains "4 comments await moderation" for moderators, linking to Pending.

---

## 5. Spam and abuse

### 5.1 Layers

| Layer | Stops | Where |
|---|---|---|
| Email confirmation | Bots that can't read mail; posting as someone else | 3.3 |
| Rate limits | Floods from one network or at one address | 5.3 |
| Honeypot | Naive form-filling bots | 5.2 |
| Link limit, words, member names | Link spam, known phrases, impersonation | 4.2 |
| Previous spam | A commenter who spammed before | 4.2 |
| Comment guard | Whatever a service or a CAPTCHA plugin catches | 14.2 |
| Moderation | Everything else, by default every first comment | 4 |

**No CAPTCHA in core.** It needs a third-party script on every post page, sends readers' data
to that service, and fails readers who can't solve it. #191 decided the same for signup. A
CAPTCHA belongs in a plugin: a guard to verify the answer, and a public page injection to
add its widget once plugin-system S13 exists (open question 7).

### 5.2 Honeypot and timing

- The form has a field named `website`, hidden with CSS and `aria-hidden`, `tabindex="-1"`,
  `autocomplete="off"`, labelled "Leave this empty". Filled → the comment goes to `spam`
  silently, and the answer is the usual one.
- **No timestamp check.** Post pages are cached for minutes, so a form's render time is not
  when the reader saw it. `gl-comments.js` could stamp the time the page was shown, but a
  reader without scripts would then look like a bot. Not worth it in v1.

### 5.3 Rate limits

New limiters on #190's mechanism (`RATE_LIMIT_*`, per minute, 0 disables, a zero `Config`
has them off):

| Limiter | Key | Default | On exceeding |
|---|---|---|---|
| `commentPost` | `clientKey` | 5 / minute | visible 429 with `Retry-After` |
| `commentPostAddress` | `clientKey` + address | 3 / minute | visible 429 |
| `commentMail` | address, **silent** (`allowSilently`) | 1 confirmation mail / 10 minutes | stored, no mail (3.3) |
| `commentConfirm` | `clientKey` | the `accountToken` limit | visible 429 |
| `commenterDataRequest` | `clientKey`, then address silently | as forgot-password | 202 |

The general `/public` limit still applies to reads. Per-address-only keys are used only for
silent mail cooldowns, which can't lock anyone out of posting (#190's rule).

**Volume caps** beyond rates: at most 20 unconfirmed comments per address, and 200 pending
comments per post (the 201st is answered `429 comments_busy`, "Too many comments are waiting
for review on this post"), so a flood can't bury the queue.

### 5.4 Links in the text

Links are rendered, never stored as HTML (6.3), with `rel="nofollow ugc noopener"` and no
`target`. Only `http` and `https` URLs are linked. A link's text is the URL itself, cut to 60
characters with an ellipsis, so a reader always sees where it goes.

### 5.5 Abuse after publication

There is no "Report" button in v1: on a moderated site the comment already passed a person,
and a report button needs its own abuse handling. A moderator unapproves or trashes. A
commenter can be **blocked**: their address's later comments go to spam silently. Blocking is
a commenter's flag, shown on their page, and undoable.

---

## 6. Storage

### 6.1 Tables

```sql
CREATE TABLE commenters (
  id             bigserial PRIMARY KEY,
  email          varchar(254) NOT NULL,          -- as typed, for mail
  email_lower    varchar(254) NOT NULL UNIQUE,   -- matching
  display_name   varchar(60)  NOT NULL,          -- the latest one used
  verified_at    timestamptz,
  blocked_at     timestamptz,                    -- 5.5
  last_spam_at   timestamptz,                    -- 4.2 previous_spam; outlives the spam rows
  user_id        bigint REFERENCES users (id) ON DELETE SET NULL,  -- reserved for reader accounts (3.1 B)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- Browser keys (3.3). Only the hash is stored.
CREATE TABLE commenter_keys (
  key_hash     bytea  PRIMARY KEY,
  commenter_id bigint NOT NULL REFERENCES commenters (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE TABLE reader_comments (
  id              bigserial PRIMARY KEY,
  post_id         bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  parent_id       bigint REFERENCES reader_comments (id) ON DELETE SET NULL,  -- the comment it answers
  root_id         bigint REFERENCES reader_comments (id) ON DELETE CASCADE,   -- its thread; NULL for a top-level one.
                                                  -- The cascade only runs when a post goes, or a root with no
                                                  -- approved replies is deleted: one with replies becomes a tombstone (6.4)
  commenter_id    bigint REFERENCES commenters (id) ON DELETE SET NULL,       -- a reader's
  author_user_id  bigint REFERENCES users (id) ON DELETE SET NULL,            -- a member's (3.4)
  display_name    varchar(60) NOT NULL,          -- as posted
  body            text NOT NULL CHECK (char_length(body) <= 4000),
  status          varchar NOT NULL CHECK (status IN ('unconfirmed', 'pending', 'approved', 'spam', 'trash')),
  trashed_from    varchar,                        -- the status a restore puts back
  held_reason     varchar,                        -- 4.2, NULL when not held
  held_detail     varchar(200),                   -- a guard's reason, a matched word
  notify_replies  boolean NOT NULL DEFAULT false, -- 8.2, the reader's consent
  network_hash    bytea,                          -- 7.2, NULLed after 30 days
  removed_at      timestamptz,                    -- a tombstone (6.4)
  confirm_token_hash bytea,                       -- while unconfirmed
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  moderated_by    bigint REFERENCES users (id) ON DELETE SET NULL,
  moderated_at    timestamptz,
  edited_at       timestamptz,                    -- a member's own comment only
  CHECK ((commenter_id IS NULL) OR (author_user_id IS NULL))
);
CREATE INDEX reader_comments_thread  ON reader_comments (post_id, root_id, created_at) WHERE status = 'approved';
CREATE INDEX reader_comments_queue   ON reader_comments (status, created_at DESC);
CREATE INDEX reader_comments_by_commenter ON reader_comments (commenter_id);

-- Unsubscribe tokens for reply notifications (8.2), one per comment that asked.
CREATE TABLE reader_comment_unsubscribe_tokens (
  token_hash bytea  PRIMARY KEY,
  comment_id bigint NOT NULL REFERENCES reader_comments (id) ON DELETE CASCADE
);

-- Notification outbox (8.4).
CREATE TABLE discussion_mail (
  id          bigserial PRIMARY KEY,
  kind        varchar NOT NULL,                    -- reply, author, moderation
  commenter_id bigint REFERENCES commenters (id) ON DELETE CASCADE,  -- a reader recipient, or
  user_id      bigint REFERENCES users (id) ON DELETE CASCADE,       -- a member; never an address
  CHECK ((commenter_id IS NULL) <> (user_id IS NULL)),
  post_id     bigint,
  comment_ids bigint[] NOT NULL,                   -- coalesced
  due_at      timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  sent_at     timestamptz
);

ALTER TABLE posts ADD COLUMN discussion varchar NOT NULL DEFAULT 'default'
  CHECK (discussion IN ('default', 'open', 'closed', 'off'));     -- 12.3

-- When the post first went live, for "close after N days" (12.4). posts has no publish
-- date today (publish_at is the schedule). Set once, by a trigger, when post_status first
-- becomes 'published'; backfilled from each published post's earliest post_versions row.
ALTER TABLE posts ADD COLUMN first_published_at timestamptz;
```

Plus the settings of 12.1 as `settings` columns, a `"comments"` entry in `post_types.supports`
for `post` (12.2), and the Profile preferences of 8.3 on `users`. `created_at` is a plain
default, so a later importer can write it.

Neither a commenter nor a comment has a foreign key to #192's tables, and #192's code never
reads these.

### 6.2 Threading

| | A. Flat | B. **Two levels shown, real parent kept** (recommended) | C. Nested to depth N (WordPress, default 5) |
|---|---|---|---|
| Reading on a phone | Easy, but conversations interleave | Easy | Indents run out at 375px past 2 or 3 |
| "Who answered whom" | Lost | Kept: "Replying to Ana" on a reply to a reply | Kept by indentation |
| Notifications | To whom? | To the real parent's commenter | To the real parent's commenter |
| Verdict | A setting (`comments_threading: flat`) | **Default** | Rejected for v1 |

B stores `parent_id` (the comment answered) and `root_id` (the top-level comment). A reply
to a reply is shown in the root's list with "Replying to Ana", linking to `#comment-<id>`.
The storage allows C later without a migration.

**Order and pages.** Threads are ordered by their root's `created_at`, oldest first (a
setting can make it newest first); replies inside a thread always oldest first. A page holds
`comments_per_page` threads (default 30), each with every approved reply. Page 1 is the post's
URL; page N is `?comments=N#comments` (11.3). A thread over 100 replies shows the first 100
and "Show more replies" (a link to `?thread=<root id>`, a page of that thread alone).

### 6.3 Text

- **Plain text** up to 4000 characters, at least 2 after trimming; CR LF normalized; at most
  2 blank lines in a row kept; control characters and bidi overrides refused (400
  `body_invalid`).
- **Rendered, never stored as markup:** paragraphs on blank lines, `<br>` on single newlines,
  links per 5.4, everything else escaped by JSX. Nothing in a comment reaches `set:html`.
- **Validated once, in Go,** with the limits in a vectors file the form's counter reads.

### 6.4 Editing and deletion

- **Readers don't edit in v1** (open question 5). Editing needs the reader to be recognised on
  the page, which makes the page personal (3.3, 10), and an edit after approval would need
  moderating again. A reader deletes a comment (13.2) and writes it again.
- **Members edit their own comments** from the drawer. The comment shows "Edited".
- **Moderators don't edit readers' text** (open question 9). They approve, unapprove, mark
  spam, trash, or delete. Putting words in a reader's name is worse than removing them.
- **Trash** keeps the row (`trash`, `trashed_from`). Unlike posts' trash (#327, which is never
  emptied on its own), comments' trash is emptied after 30 days: a moderated thread produces
  far more trash than a post list, and nobody restores a reader's comment a year later.
  **Delete permanently** (from Trash or Spam, asks first) deletes the row.
- **A comment that isn't shown but has approved replies renders as a placeholder.** The thread
  read selects threads whose root is approved **or** has an approved reply, and a root or
  parent that isn't approved (pending again, spam, trash) renders "This comment was removed",
  so unapproving or trashing a comment never hides its replies. Restoring it brings its text
  back.
- **Deleting a comment that has approved replies makes a tombstone** instead of deleting the
  row (a moderator's Delete permanently, a reader's delete, an erasure): `removed_at` set, body
  emptied, name and commenter cleared, status `approved`. So `root_id`'s cascade never takes
  approved replies with it. A tombstone whose last reply goes is deleted by the hourly job.
- Spam is deleted after 30 days, pending after 90 (the queue is a queue, not an archive).

### 6.5 What the post's lifecycle does

| The post | Its thread |
|---|---|
| Published | Shown when its discussion is open or closed (12.4) |
| Unpublished, archived, scheduled again | Hidden (`/public` answers 404 for the post); kept; moderators still see it |
| Moved to the trash | Hidden; kept; the queue marks it; no new comments |
| Restored from the trash | Back as it was |
| Deleted permanently | **Deleted with it** (`ON DELETE CASCADE`). Commenters stay: they may have comments elsewhere; one left with none is pruned after 30 days (6.6) |
| Its type made non-public, or its type's Comments field turned off | Hidden (off), kept |
| A new version published, or one restored | No effect: comments aren't content, and #358's snapshot doesn't hold them |
| Slug or URL structure changed | No effect: comments belong to the post id; mails built afterwards use the new URL |
| Its owner removed (`RemoveUserTx`) | No effect on readers' comments; that member's own comments lose their badge (3.4) |

No post column holds a count. `GET /public/posts/:id` and the thread answer count approved
comments through `reader_comments_thread`, cached (10).

### 6.6 Jobs

One loop, `RunDiscussionMaintenance` (hourly, `DISCUSSION_MAINTENANCE_INTERVAL`, 0 = off, in
every replica with `FOR UPDATE SKIP LOCKED` on the rows it deletes):

- unconfirmed older than 48 hours; spam and trash older than 30 days; pending older than 90;
- `network_hash` older than 30 days set to NULL;
- expired browser keys;
- tombstones with no replies left;
- commenters with no comments and no keys, after 30 days, **unless blocked** or with a
  `last_spam_at` in the last 90 days: those rows are what the block and `previous_spam` rules
  remember, and they hold no text.

### 6.7 Backups

Everything is in Postgres, so `pg_dump` covers it. The migrations need working downs for
`test-restore.sh`. `backups.md` gains a row naming the tables and a note for 13.3: a restore
brings back data erased after the backup was taken.

---

## 7. Privacy

### 7.1 What is public, what is not

| Data | Public | Moderators | Logs, activity, plugin events |
|---|---|---|---|
| Name as posted, text, time, status "approved" | Yes | Yes | Never the text or name |
| Email | **Never** | Yes (open question 6) | **Never** |
| IP address | Never | Never stored | Never |
| Network hash | Never | Only as "N other commenters from this network" | Never |
| Browser key, tokens | Never | Never | Never |
| User agent | Not stored | — | — |

`route_auth_test.go` gains a case that renders every `/public` comment response for a
commenter with a known address and fails if the address, its lower-case form or any hash
appears in the body. The same check runs over the HTML of a post page with comments
(`theme.astro.test.ts`).

### 7.2 The network hash

`network_hash = HMAC-SHA256(key, clientKey(ip))`, the key derived from the PASETO local key
with HKDF and the label `golive.discussion-network`, so there is no new secret to manage.
Rotating the PASETO key only stops new comments matching old ones, which is harmless. The
hash is NULLed after 30 days. It answers one question, "how many other commenters posted from
this network lately", and can't be turned back into an address without guessing the key.

### 7.3 Logs

The API's no-secrets rules apply: handlers log `comment_id`, `post_id`, `commenter_id` and
outcomes, never an address, a name, the text, a token or a key. The web's comment endpoint
logs by route pattern only (`log.ts`), never the form body.

### 7.4 Activity (#324)

Readers aren't members, so their own actions (posting, confirming, unsubscribing,
requesting data) are **not** activity: they would flood the feed, and they're personal. The
queue is their record. Members' actions are, with ids only (15.2).

### 7.5 The privacy notice

Under the form, always: "Your email is never shown. We use it to confirm your comment and, if
you ask, to tell you about replies. Confirming keeps a cookie on this browser so you won't be
asked again." Admins can replace it (`comments_notice`, plain text, at most 400 characters)
and point it at a privacy page (`comments_privacy_page_id`, a published page, linked as
"Privacy"). Open question 12.

---

## 8. Notifications

### 8.1 Which mails

| Mail | To | When | Contains |
|---|---|---|---|
| **Confirm your comment** | The address typed | A comment without a key (3.3), at most one per 10 minutes per address | The site title, the post's title and URL, the confirm link, "If you didn't write a comment, ignore this; nothing is published." **Never** the name or text typed (problem 3) |
| **New reply** | A commenter who ticked "Email me replies" on the comment answered | A reply to it is approved (not their own) | The replier's name, the reply's first 300 characters (moderated text), a link to it, unsubscribe |
| **New comments on your post** | The post's published byline authors, by preference | A comment on their post is approved | Name, first 300 characters, link to the post and to Discussion |
| **Comments await moderation** | Moderators, by preference | The queue grew | The count, the newest three posts' titles, a link to Pending. Never commenters' details |
| **Your comments** | The address typed on "Manage your comments" | A data request (13.2) | A link, nothing else |

All use `mailer/templates/` (text and HTML), the site's title and language, and links from
`PUBLIC_BASE_URL`.

### 8.2 Consent and unsubscribing

- **"Email me replies" is unchecked by default**, per comment, stored as `notify_replies`.
- Every reply mail has a **one-click unsubscribe** (RFC 8058: `List-Unsubscribe` with
  `List-Unsubscribe-Post`) to the site's `POST /gl-comments/unsubscribe/:token` (9.4), plus a
  visible link to `/comments/unsubscribe#token=` whose page has the button. The one-click token
  is in the URL's path, which #233 forbids for other tokens. It is allowed here because RFC 8058
  requires it, the token can only turn one comment's notifications off, and both servers log
  routes by pattern, never the path.
- The page also offers "Stop all mail from this site" (every subscription of that commenter).
- A blocked commenter, or one whose replies are all unsubscribed, gets nothing but
  confirmations.

### 8.3 Members' preferences

Profile gains **Notifications** (members' own, `users` columns):

- **Comments on my posts:** Each one (coalesced, 8.4) · Daily digest · Off. Default: Daily
  digest (open question 8).
- **Comments to moderate** (editors and admins): Each hour at most · Off. Default: each hour.

### 8.4 Delivery

- **Confirmations and data links** keep #191's pattern: sent after the response
  (`runInBackground`), with the silent cooldown. They are one mail for one request.
- **Notifications go through `discussion_mail`**, an outbox written in the same transaction
  as the approval, so an approval that commits is never without its mail, and one that rolls
  back sends none. `RunDiscussionMail` (every 30 seconds) claims due rows `FOR UPDATE SKIP
  LOCKED` with a lease, as `post_reminders` are claimed (`claimed_until`, `attempts`), builds each mail from the current data (a comment trashed meanwhile is left out;
  a mail left empty is dropped), sends, and records. Rows for the same recipient and kind
  coalesce: a new comment joins a row not yet due (reply and author mails wait 5 minutes,
  moderation an hour), so a busy thread sends one mail, not twenty. Failures retry with the
  scheduler's backoff, at most 8 attempts. Sent rows are pruned after 7 days.
- Recipients are stored as ids and resolved to an address when sending, so an erased
  commenter or a removed member is simply skipped.

---

## 9. The public API

### 9.1 Reads

| Route | Answers |
|---|---|
| `GET /public/posts/:id/comments?page=N` | `{discussion: {state, closes_at, count}, threads: [{comment, replies: [...]}], pagination}` for a published post of a public type. `state` is `open`, `closed` or `off` **without the clock** (12.4); `closes_at` is when an `open` state ends, or null. `off` answers no threads. 404 for a post `/public` doesn't serve, 404 past the last page. |
| `GET /public/posts/:id/comments?thread=<root id>` | One thread with all its replies (6.2) |
| `GET /public/posts/:id` and `/slug/:slug` | Gain `discussion: {state, closes_at, count}`, so the post route knows whether to render the section before fetching it |

All three are cached by #185's middleware with every other `/public` read, which is why
none may read the clock (problem 8).

A comment in an answer is `{id, parent_id, root_id, name, badge, avatar, body, created_at,
edited, removed, replying_to}`: `badge` is `author`, `staff` or null; `avatar` a member's path
(through `safeAvatarSrc`) or null, the renderer drawing initials; `replying_to` the name
answered by a reply to a reply; `removed` a tombstone with empty `name` and `body`. Nothing
else: no email, no commenter id, no status (everything served is approved).

### 9.2 Writes

These are the first POSTs under `/public`, and the first anonymous writes outside
`/api/v1/auth`. Browsers can't reach `/public` (section 1), so the only caller is the web's
endpoint (9.4), which is what lets a plain HTML form use them. Each binds with `bindJSON` and
a 16 KiB body limit (`bodyLimitOverrides`), is rate-limited on the browser's address (5.3,
from the endpoint's `X-Forwarded-For`, which the API trusts from the web container), is
declared in `publicCacheNoPurgeRoutes` or, for the two that can publish a comment, in the
purge list with a condition (section 10), and is listed in a new `publicPOSTRoutes` audit with
its reason (15.1). Putting them under `/api/v1` instead would expose them to browsers
directly, beside the endpoint's origin check, for no gain.

| Route | Body | Answers |
|---|---|---|
| `POST /public/posts/:id/comments` | `{name, email, body, parent_id?, notify_replies, website}` + header `GoLive-Commenter-Key` | 202 `{outcome: "confirm_email"}` (no key, or a key for another address), 202 `{outcome: "pending", comment_id}` or 201 `{outcome: "published", comment_id}` (a valid key). 409 `comments_closed` / `comments_off`, 404 `parent_not_found` (the parent isn't approved on this post), 400 per field, 429 |
| `POST /public/discussion/confirm` | `{token}` | `{outcome: "pending" \| "published", post_url, comment_url, set_key}`; 400 `invalid_token` for every bad case |
| `POST /public/discussion/unsubscribe` | `{token, all?}` | 204 |
| `POST /public/discussion/unsubscribe/:token` | RFC 8058's form body | 204 |
| `POST /public/discussion/data-request` | `{email}` | 202, always the same |
| `POST /public/discussion/data` | `{token}` | The commenter's export (13.2); the token stays valid for its hour |
| `POST /public/discussion/data/delete` | `{token, comment_id?}` | 204: one comment, or all (erasure) |

`set_key` is the new browser key in the answer of a confirm, so the web endpoint can set the
cookie (9.4); the API never sets cookies on `/public`. A browser key that is valid but for
another address counts as no key, and an expired or unknown one is ignored, so neither
answer says anything about an address.

A reply is accepted only to an **approved** comment of the same post, whose thread is open.
`notify_replies` is stored even when confirmation is pending.

### 9.3 Admin routes

Under `/discussion` (problem 2), `canModeratePosts` unless noted:

| Route | Does |
|---|---|
| `GET /discussion/comments?status=&post_id=&commenter_id=&q=&page=` | The queue (4.4) |
| `GET /discussion/counts` | Per status; Home's Needs attention |
| `GET /discussion/comments/:id/thread` | The drawer |
| `PUT /discussion/comments/:id/status {status}` | Approve, unapprove, spam, not spam, trash, restore |
| `POST /discussion/comments/bulk {ids, action}` | Per-comment answers |
| `DELETE /discussion/comments/:id` | Delete permanently (spam or trash only) |
| `POST /discussion/posts/:id/comments {body, parent_id?}` | A member's comment or reply (3.4) |
| `PUT /discussion/comments/:id {body}` | A member's own comment only |
| `GET /discussion/commenters/:id`, `GET /discussion/commenters?email=` | A commenter's page; lookup by exact address |
| `PUT /discussion/commenters/:id/block {blocked}` | 5.5 |
| `GET /discussion/commenters/:id/export` | Admin; 13.1 |
| `DELETE /discussion/commenters/:id` | Admin; erasure, 13.1 |
| `PUT /posts/:id/discussion {discussion}` | Anyone who may edit the post's details (`canEditPostDetails`); 12.3 |

Settings are fields of `GET/PUT /settings` (admin), the public ones (`comments_enabled`,
the notice) readable as today.

### 9.4 The web's write endpoint

The API binds JSON and `/public` is server-side, but a form without scripts posts
`application/x-www-form-urlencoded` to its own site. So the site posts to **Astro endpoints**
under `/gl-comments/` (`posts/:id`, `confirm`, `unsubscribe`, `unsubscribe/:token` for RFC
8058, `data-request`, `data`, `data/delete`), each calling its `/public` route at
`SERVER_MEDIA_URL`. Each one:

1. refuses a cross-origin browser request (`Sec-Fetch-Site`, else `Origin` against the site's
   host), as `cookieOriginGuard` does for login, except the RFC 8058 one-click route, which
   mail providers call from their own servers (its token is the whole authority);
2. maps the form to the API's JSON, forwards `X-Forwarded-For` with the browser's address
   (Astro's `clientAddress`, as `apiProxy.ts` does), `requestIdHeaders()`, and the
   `gl_commenter` cookie's keys as `GoLive-Commenter-Key`;
3. sets the cookie from `set_key` (`Path=/gl-comments`, 3.3);
4. answers a browser without scripts with a **303** back to the post,
   `?commented=pending|published|confirm#comment-form` on success. On a refusal it answers
   a short themed page itself (422 or 429: "Your comment wasn't posted", the reason, the
   typed text in a read-only textarea to copy, and **Back to the post**), so nothing is kept
   on the server and a mistake doesn't lose the text. `gl-comments.js` (which sends
   `Accept: application/json`) gets the API's JSON instead.

The endpoint is `private, no-store`, outside `CACHEABLE_PAGE_ROUTES`. A post page with a
`commented` parameter is `private, no-store` too (`httpCache.ts` gains the rule), since it
shows a notice for one reader.

---

## 10. Caching (#185)

- **API.** The thread reads are ordinary `/public` reads, so #185's middleware caches them
  (5 minutes, keyed by path and query) with no new code. **What purges**, after the commit
  and through #185's one global purge: a comment entering or leaving `approved` (moderation,
  bulk, a member's comment, a confirm or keyed post that publishes, a reader's delete, an
  erasure), a tombstone, a member's edit, a post's `discussion` change, and a Settings ›
  Discussion save. Routes whose effect depends on the outcome (a reader's POST that is only
  pending, a confirm that leaves it pending) purge only when a comment was published, as
  `publicCachePostDetailRoutes` purge only for published posts. Events that already purge
  (publish, unpublish, trash, delete) cover the thread too.
- **The global purge is the cost.** Each approval drops every cached `/public` read, so a
  moderator approving 20 comments one by one causes 20 cold reads per route. At a
  moderator's pace that is fine; bulk actions purge once per request. If it shows in C3's
  measurements, a `comments` namespace of its own (generation per post) is the fix, with
  `cache/namespace.go`'s mechanism, and nothing else in this design changes.
- **No clock in a cached answer.** The cached `discussion` says `open` with `closes_at`; the
  post route and the comments block apply `closes_at` with the shared rule (12.4), so a
  cached answer never shows an open form for long past its date.
- **Pages.** Post pages stay `public, max-age=60, stale-while-revalidate=300`. A newly
  approved comment reaches a reader behind a CDN within about six minutes at worst. The
  author of the comment never waits: their notice comes from their own response (9.4), and
  `gl-comments.js` shows their published comment in place.
- **Close after N days** changes the state with no event. The renderer applies `closes_at`
  on every render, so only a cached page (at most the page's own max-age plus its
  revalidation window) can still show the form; the write path checks the real state, so
  that form gets `409 comments_closed` ("Comments on this post closed on November 3.").
- **Nothing per reader is cached.** The browser key never reaches a page (3.3), the notice
  pages are `no-store`, and the confirm, unsubscribe and data pages are `no-store` account-style
  pages.

---

## 11. Rendering

### 11.1 One component

`src/components/comments/PostComments.astro` is core, not a theme's: it takes the post, the
thread answer and the site settings, and renders the section, the threads and the form. Its
markup is core's, with classes themes style (`comments`, `comments-title`, `comment`,
`comment-replies`, `comment-meta`, `comment-badge`, `comment-removed`, `comment-form`,
`comments-closed`, `comments-pagination`), documented in `src/components/blocks/README.md`
next to the site blocks.

- **Code layouts** render `<PostComments …/>` where they want it. The default theme puts it
  in `post-end`, after "Written by" and the older/newer links and before "More to read" (the
  default theme canvas's post board ends that way). `themes/README.md`'s layout props gain
  `comments` (the thread answer, or null), fetched by the post route in parallel with the
  byline and the post end, failing soft (`comments_fetch_failed`, then the section renders
  nothing).
- **The comments site block (#500)** is a flow atom, `comments`, with one attr, `title`
  (default "Comments", capped at 60). It is allowed only in `single*` and `page*` templates,
  at most once, never in a part, a `query` or a `post_template` (rules of theme-builder 4.2,
  `siteBlockVectors.json`). `collectTemplateNeeds` sees it and fetches page `?comments=N` of
  the route's post, and the block renders `PostComments` from the `SiteRenderContext`. Outside
  a post route, or in a post's body, it renders nothing, as every site block does.
- **Parity (theme-builder T17).** Both paths render the same component, so converting the
  default theme to block templates changes nothing here.

### 11.2 What the section shows

| `discussion.state` | Section |
|---|---|
| `off` | Nothing at all |
| `closed`, no comments | Nothing |
| `closed`, comments | The threads, then "Comments are closed." |
| `open`, no comments | "No comments yet." and the form |
| `open` | "3 comments", the threads, pagination, the form |

The form: Comment (textarea, counter from the vectors), Name, Email ("Never shown"),
"Email me replies" (unchecked), the honeypot, **Post comment**, and the privacy notice
(7.5). A Reply link under each comment goes to `?replyto=<id>#comment-form`, which renders the
form with "Replying to Ana · Cancel" and the hidden `parent_id`. With scripts,
`gl-comments.js` moves the form under the comment instead, without a reload.

### 11.3 URLs

- A comment is `#comment-<id>`; the section is `#comments`; the form is `#comment-form`.
- Page N of the threads is `?comments=N`; its canonical stays the post's URL, so search
  engines index one page. A mail that links to a comment works out its page when it is sent
  (the page can drift by one if earlier threads are removed; the anchor then misses, and the
  reader lands on the section).

### 11.4 `gl-comments.js`

Plain and unbundled in `public/`, like `gl-embeds.js`, added once per page through the page
scope (`blocks/utils/pageScope.ts`) when a form renders. It submits with `fetch`, shows the
outcome in the form's status region, inserts a published comment in place (and a pending one
as "Awaiting moderation · only you can see this", until reload), moves the form for replies,
and keeps the counter. Without it everything works through 9.4's redirects. The public CSP is
untouched: it is a same-origin `<script src>`.

### 11.5 Accessibility

Each comment is an `<article aria-labelledby>` with the name and a `<time>` formatted by
`formatSiteDate`; replies are a list inside their thread. The form's fields have labels,
errors are tied with `aria-describedby` and focused after a failed submit, and the outcome is
spoken by a status region present and empty from the start (#477's rule). The section and the
form get axe cases in `themes/default/theme.astro.test.ts`.

### 11.6 Public pages

`/comments/confirm`, `/comments/unsubscribe` and `/comments/your-data` are reader pages, not
account pages: they render in the **theme** (the 404 page's path, `ThemedErrorPage`'s
pattern), noindex, `no-store`, each a short panel with one button (tokens spent on the button,
never on load). They read the token from the fragment with `gl-comments.js` (no inline
script), so they need scripts; the mail says so in its plain-text part.

---

## 12. Settings

### 12.1 Site: Settings › Discussion (admin)

| Setting | Values | Default |
|---|---|---|
| `comments_enabled` | Allow comments on this site | **Off** |
| `comments_moderation` | Hold every comment · Hold until a commenter has one approved · Publish when no rule holds it | Hold until approved once |
| `comments_max_links` | 0–10 | 1 |
| `comments_hold_words`, `comments_spam_words` | One per line (4.2) | empty |
| `comments_close_after_days` | 0 (never) – 3650 | 0 |
| `comments_threading` | Replies · Flat | Replies |
| `comments_order` | Oldest first · Newest first | Oldest first |
| `comments_per_page` | 10–100 threads | 30 |
| `comments_notice`, `comments_privacy_page_id` | 7.5 | core's text, none |

Off hides Discussion's settings below the switch, renders no section anywhere, and answers
the write routes `409 comments_off`. Existing comments are kept and come back when it is
turned on.

### 12.2 Post type: the Comments field

`post_types.supports` gains `"comments"`. The migration adds it to `post`, not to `page` nor to
custom types. On the Post types screen it is a row of **Fields** ("Comments · Readers can
comment on published items"), editable for Posts and Pages too, the one field that is (problem
4: `PUT /post-types/:id` for a built-in type accepts a change of `comments` in `supports` and
nothing else).

### 12.3 Post: Discussion

`posts.discussion`: **Default** (follow the type and the site), **Open**, **Closed** (keep
showing, accept no more), **Off** (hide). It sits in the editor's settings panel, Post tab, as
a **Discussion** section with the choice, what Default means now ("Open · closes on Dec 3"),
and "12 comments · 2 waiting" linking to Discussion filtered by the post.

**It applies at once, outside the publish snapshot.** It is not in `golive_post_settings()`,
not versioned, and doesn't make a post "Changes not published". Closing a thread that turned
nasty has to work now, not on the next Update, and comments aren't the post's content.
Restoring a version leaves it alone. Who may change it: anyone who may edit the post's
details. Activity: `post_discussion_changed` (15.2).

### 12.4 The state, one rule

```
discussionState(site, type, post, now):
  off     if !site.comments_enabled, or post.discussion = 'off',
          or (post.discussion = 'default' and 'comments' ∉ type.supports),
          or the type is not public
  closed  if post.discussion = 'closed',
          or (post.discussion = 'default' and site.comments_close_after_days > 0
              and post.first_published_at + days <= now)
  open    otherwise
```

An explicit **Open** ignores the close-after timer, so a post can stay open on purpose. The
rule is one function in Go and TypeScript with shared vectors (`discussionStateVectors.json`),
the admin's panel and the API agreeing by construction. "First published" is the new
`posts.first_published_at` (6.1), which a re-publish, an Update or a restore from the trash
doesn't move.

**Where the clock is applied.** The cached `/public` reads compute everything but the time
and answer `closes_at` (problem 8). The write path, the admin and the renderer apply it:
`closed` once `now >= closes_at`. That's the rule's split in both languages:
`discussionSetting(site, type, post)` (cacheable) and `discussionState(setting, closesAt,
now)`.

---

## 13. Export and erasure

### 13.1 By an admin

A commenter's page (from the drawer, or `Discussion › Find a commenter` by exact address):
their name, address, verified date, counts, comments (every status) and subscriptions, with:

- **Export** downloads a JSON file: the commenter (address, names used, dates), every comment
  with its post's title and URL, status and dates, and the subscriptions. No hashes, keys or
  network data. Activity `commenter_exported`.
- **Erase** (asks first: "Delete Ana's 14 comments and everything stored about this address?
  Comments with replies are replaced by 'This comment was removed'. This can't be undone.")
  runs one transaction: tombstones for comments with approved replies, deletes the rest, the
  keys and tokens, and the commenter (its outbox rows go by `ON DELETE CASCADE`). Activity `commenter_erased`
  with the count, never the address.

### 13.2 By the reader

Every reader mail links to **Manage your comments**, and the privacy notice links to
`/comments/your-data`: the reader types the address and gets a link (always the same
answer). The link's page, valid an hour, lists their comments with **Delete** on each,
**Download my data** (13.1's file), **Stop all mail** and **Delete everything** (13.1's erase,
asked first). Self-service needs no moderator and leaves no activity entry (7.4).

### 13.3 What it doesn't reach

Backups taken before the erasure keep the data until they age out (`backups.md`: up to 12
months for monthly sets). The privacy notice's default text doesn't promise more, and
`backups.md` says that a restore brings back erased data, so an admin restoring a backup
should repeat recent erasures. There is no erasure log to replay: it would have to keep the
addresses it erased.

Members' own data is out of scope here: their comments follow member removal (3.4).

---

## 14. Plugins

### 14.1 Events

A trigger on `reader_comments` writes to `plugin_events` exactly as the `posts` trigger does
(only when an enabled plugin subscribes, `ON CONFLICT DO NOTHING`), with the comment's
`post_id` and `data: {comment_id, root_id, status, previous_status, by_member}`:

| Event | When |
|---|---|
| `comment.created` | A comment leaves `unconfirmed` (a reader's is created then, in effect), or a member's is inserted |
| `comment.approved` | `status` becomes `approved` |
| `comment.unapproved` | `status` leaves `approved` for `pending` |
| `comment.spammed` / `comment.trashed` | `status` becomes `spam` / `trash` |
| `comment.deleted` | `DELETE`, or a tombstone |

Ids only, as every event. The dispatcher, ordering (per plugin and post, so a thread's events
arrive in order), retries and webhooks (#460) are unchanged: comment events are hooks a
webhook plugin may declare.

A plugin that wants the text declares **`comments:read`**: `Host.Comments()` returns a
comment's name, text, status and post. Commenters' addresses are not readable by observers at
all.

### 14.2 The comment guard

`{ "event": "comment.before_create", "on_error": "allow" | "hold" }`, on #459's pattern:

- It runs on the write path after core's checks and before the insert, so it sees the
  request: `{post_id, parent_id, name, email, body, ip, user_agent, has_browser_key}`. That's
  what Akismet-style services need, and the only point where the IP exists.
- It answers **allow**, **hold** (with a reason the queue shows as `plugin`) or **spam**. It
  can't approve: moderation stays core's.
- Budget: 2 seconds each, 3 in total, sequentially by `(priority, slug)`, first spam wins
  over a hold. An error or timeout is `on_error`, default `allow` (core's rules then decide).
- It needs the capability **`comments:private`**, and the enable dialog says "Checks reader
  comments. Receives commenters' email and IP address". A guard is never a webhook (it
  waits on the request), as `post.before_publish` isn't.
- The verdict is stored with the comment (`held_reason`, `held_detail`), so confirming a
  comment later applies it without calling the plugin again.

### 14.3 Later

A CAPTCHA plugin needs a widget on the page: plugin-system S13 (public page injection). Until
then a guard can only judge what the form sends.

---

## 15. Access and activity

### 15.1 Routes

- `/discussion/*`: `canModeratePosts`; settings, export and erasure `requireSiteAdmin`.
- `route_auth_test.go` gains **`publicPOSTRoutes`**: it walks the router, and every POST,
  PUT or DELETE that answers without a token must be listed with its reason (today the
  `/api/v1/auth/*` routes; then the comment writes). It also gains: no `/public` route serves
  a non-approved comment; no `/public` answer holds an address (7.1).
- `post_reads_auth_test.go`-style cases: a contributor gets 403 on `/discussion/*`; an editor
  gets 403 on erasure.

### 15.2 Activity (#324)

`object_type = 'reader_comment'` or `'commenter'`, ids and counts only. #192 already uses
`commented` and `comment_*`, so every verb here starts `reader_comment_` (all fit the
40-character CHECK). The visibility query (`activity.sql`) gains these object types for
editors; contributors see none of them.

| Verb | Object | Payload |
|---|---|---|
| `reader_comment_approved`, `_unapproved`, `_spammed`, `_not_spam`, `_trashed`, `_restored` | comment id | `post_id` |
| `reader_comment_deleted` | comment id | `post_id`, `status` it had |
| `reader_comment_posted` (a member's) / `reader_comment_edited` | comment id | `post_id`, `parent_id` |
| `reader_comments_bulk_moderated` | post id or 0 | `action`, `count` |
| `commenter_blocked` / `commenter_unblocked` / `commenter_exported` / `commenter_erased` | commenter id | `comment_count` |
| `post_discussion_changed` (object type `post`) | post id | `from`, `to` |

Settings › Discussion saves are the existing `settings_updated` with their field names. Home's
Activity feed reads the verbs ("Ana approved a comment on *Shipping real-time collaboration*").

---

## 16. Screens and their boards

Drawn under C1 (17). Each board has its states (empty, loading, error) and, where the canvas
has both, light and dark. This document doesn't draw them.

**[GoLive Admin Redesign](https://claude.ai/artifact/XcdvESjJxeGK5dPAed7QtF)**, a new row
"9 · Discussion (reader comments, #499)", plus changes to existing boards:

1. **Discussion · queue** (new): tabs with counts, filters, rows with the held reason, bulk
   bar, empty ("Nothing waits for review"), and the comments-off state ("Comments are off for
   this site" with a link to Settings for admins).
2. **Discussion · comment drawer** (new): the thread, the reply box, the commenter's summary.
3. **Discussion · commenter** (new): their comments, Block, Export, Erase and its
   confirmation.
4. **375 · Discussion** (new): the queue on a phone, where approving and marking spam work
   (a moderator's most likely phone task); replying needs a larger screen.
5. **Settings** (existing board): a **Discussion** section after Editor (12.1).
6. **Post types · edit** (existing): the Comments row in Fields, editable on Posts (12.2).
7. **Post editor · settings panel** (existing SEO-panel board's shell): the Discussion
   section (12.3).
8. **Home** (existing): "4 comments await moderation" in Needs attention; comment verbs in
   Activity.
9. **Profile** (existing): Notifications (8.3).
10. **Sidebar** (existing): Content gains **Discussion** after Media, with the pending
    count, for editors and admins.
11. **Plugins** (existing): the enable dialog's lines for `comments:private` and the guard.

**[GoLive Default Theme](https://claude.ai/artifact/8J1ovgRB7YPYVjpDGRXZku)**, a new row
"6 · Comments":

1. **Post · comments** at 1280, light and dark: threads with replies, "Replying to", the
   Author and Staff badges, a tombstone, pagination, the form with the privacy notice,
   "Comments are closed".
2. **Comment form states**: field errors, "Check your email", "Awaiting moderation", the
   published comment in place, rate limited, closed since the page loaded, reply mode.
3. **375 · Post comments** and **375 · form states**.
4. **Reader pages**: confirm, unsubscribe, your data (request, list, erased), at 1280 and 375.

**[GoLive Blocks](https://claude.ai/artifact/F2x5Yx7DKiPs64VFsUwEpi)**: the comments block's
placeholder in the Site editor and its Block tab (#500).

Mail templates are text, reviewed on their issue (C8), not drawn.

---

## 17. Phased plan

Each phase ships with `comments_enabled` off and its switch hidden, until phase 3 gives
moderators a queue. The milestone is Post-MVP, like #499.

| Phase | Ships | Depends on |
|---|---|---|
| **0. Design** | C1 canvas boards | |
| **1. Storage and reads** | C2 tables, settings, state rule, jobs; C3 public reads and caching | C2 for C3 |
| **2. Writing** | C4 the write path, confirmation and browser key; C5 rendering in the default theme and the reader pages | C2; C1, C3, C4 for C5 |
| **3. Moderation** | C6 Discussion (queue, drawer, staff replies); C7 settings screens. **Comments can be turned on after this phase.** | C1, C2; C4 for C6's reply path |
| **4. Mail and privacy** | C8 notifications; C9 export and erasure | C4, C6 |
| **5. Extensions** | C10 plugin events and the comment guard; #500 the comments site block | C4, #458, #459; C5, #489 |

### Proposed sub-issues

Not filed: approved first. P2 is Medium and P3 is Low, as in theme-builder 15.

| # | Title | Size | Priority |
|---|---|---|---|
| C1 | design: Discussion boards, the post's comments and reader pages on the canvases | M | P2 |
| C2 | comments: storage, commenters, settings, the discussion state rule, maintenance jobs | L | P2 |
| C3 | comments: public thread reads, `discussion` on public posts, caching and purges | M | P2 |
| C4 | comments: the public write path (confirmation, browser key, rules, honeypot, limits) | L | P2 |
| C5 | themes: `PostComments`, `gl-comments.js`, the default theme's styles, reader pages | M | P2 |
| C6 | admin: Discussion (queue, drawer, bulk, staff replies, commenters, Home) | L | P2 |
| C7 | admin: Settings › Discussion, the post type's Comments field, the editor's Discussion section | M | P2 |
| C8 | mail: reply, author and moderation notifications, the outbox, unsubscribe, Profile preferences | M | P2 |
| C9 | privacy: commenter export and erasure, by admins and by readers | M | P2 |
| C10 | plugins: comment events and the `comment.before_create` guard | M | P3 |
| #500 | blocks: comments site block (exists; its scope is restated below) | S | P3 |

**C1. design: Discussion boards, comments on the post, reader pages**
- Scope: the boards of section 16 on the redesign and default theme canvases, and the
  comments block on the blocks canvas.
- Acceptance: every screen in section 16 has a board with its states, light and dark where the
  canvas has both, and the phone boards named there; this document is updated where a board
  changes a decision.
- Depends on: nothing.

**C2. storage, commenters, settings, state rule, jobs**
- Scope: the tables of 6.1, `posts.discussion` and `posts.first_published_at` (trigger and
  backfill); `supports` gaining `comments` for `post`
  (migration) and its one-field exception for built-in types (12.2); the settings of 12.1 in
  `GET/PUT /settings`; `discussionState` in Go and TypeScript with
  `discussionStateVectors.json`; `PUT /posts/:id/discussion`; the text rules of 6.3 with
  vectors; `RunDiscussionMaintenance` (6.6); `backups.md`'s row.
- Acceptance: migrations up/down/up (`test-restore.sh`); deleting a post deletes its comments
  and keeps its commenters; trashing and restoring a post leaves its comments as they were; the
  state vectors pass in both suites, including the explicit Open overriding the timer; each
  retention rule is a DB test (an unconfirmed comment at 47 and 49 hours, a tombstone losing
  its last reply, a network hash at 31 days, a blocked commenter with no comments kept);
  trashing or deleting a root with approved replies keeps the replies (placeholder or
  tombstone); `first_published_at` is set once and survives unpublish, re-publish and trash; `posts.discussion` is not in
  `golive_post_settings()` (changing it leaves `has_unpublished_changes` false).
- Depends on: nothing.

**C3. public reads and caching**
- Scope: `GET /public/posts/:id/comments` (pages, `thread`), `discussion` on the public post
  reads (9.1), cache-aside and the purges of section 10.
- Acceptance: only approved comments are served, threaded per 6.2 with `replying_to`; a post
  `/public` doesn't serve answers 404; `off` serves no threads; the route audit's address
  check (7.1) passes; no cached answer depends on the clock (`closes_at`, not a computed
  `closed`); every purge event of section 10 is tested against #185's store, and a
  pending-only POST doesn't purge; no purge inside a transaction.
- Depends on: C2.

**C4. the public write path**
- Scope: 9.2's write routes, the confirmation (3.3) with its mail template and cooldown, the
  browser key, the rules of 4.2 and the spam routing, the honeypot, the limits and caps of 5.3,
  member-name matching, `bodyLimitOverrides`; the Astro endpoint of 9.4 (origin check, form
  mapping, the cookie, the redirects, the kept form) and its `httpCache.ts` rules.
- Acceptance: no answer distinguishes a known, verified, cooled-down or unknown address (mock
  test as signup's, the pre-response calls included); the confirmation mail contains no typed
  name or text; a link confirms only its own comment, and the address's other unconfirmed
  comments are published only one by one from the confirm page (3.3 step 5); a token is spent
  only by the button's POST; a key for another address is ignored; each hold reason and spam
  route has a case; a reply to an unapproved or other post's comment is refused; a closed or
  off post refuses with its code; the form works end to end without scripts (Astro container
  test of the endpoint's redirects); the cookie's `Path` is `/gl-comments` and no page request
  carries it; the endpoint and notice pages are `no-store`; rate limits key on the browser's
  address, not the web container's; `publicPOSTRoutes` (15.1) lists every anonymous write
  with its reason.
- Depends on: C2.

**C5. rendering in the default theme, reader pages**
- Scope: `PostComments.astro` and its markup in `src/components/blocks/README.md`; the post
  route's fetch and the `comments` layout prop; the default theme's placement and styles;
  `gl-comments.js` (11.4); the reader pages of 11.6; axe cases.
- Acceptance: every state of 11.2 renders as the C1 boards draw it; comment text never reaches
  `set:html` and links carry `nofollow ugc noopener`; a failed thread read renders the post
  without the section; whole-page snapshots updated with the change listed; the default
  theme's `var()` and contrast tests pass; axe passes on the section, the form in each state
  and the reader pages.
- Depends on: C1, C3, C4.

**C6. admin: Discussion**
- Scope: section 4.4: the queue, the drawer, bulk actions, staff comments and replies (3.4),
  commenters' pages with Block, the sidebar entry and count, Home's Needs attention, the
  activity verbs of 15.2 and their feed wording; rules in `lib/discussion.ts` (tested); the 375
  queue.
- Acceptance: a contributor has no entry and gets 403 on the routes; each status change and
  bulk action answers per comment and records its verb; replying to a pending comment approves
  it first; a member's reply shows its badge (Author on the published byline, else Staff) and
  loses it when the member is removed; Approve and Spam work at 375; keyboard and screen reader
  paths as for the posts list.
- Depends on: C1, C2, C4.

**C7. settings screens**
- Scope: Settings › Discussion (12.1), with the switch hidden until this issue ships; the
  Comments field on Post types (12.2); the editor's Discussion section (12.3).
- Acceptance: the form refuses what the API refuses (word lists, ranges); Off hides the rest
  and the site's sections; Posts' Comments field saves while its other fields stay locked; the
  editor's section shows what Default means now from the shared rule and applies at once
  (the public thread reflects it after the purge, with no Update).
- Depends on: C1, C2.

**C8. notifications**
- Scope: section 8: `discussion_mail` and `RunDiscussionMail`, the reply, author and
  moderation mails, coalescing, unsubscribe (both forms) and its page, Profile's preferences.
- Acceptance: an approval that rolls back sends nothing; twenty replies in a minute send one
  mail; a comment trashed before its mail is due is left out; an unsubscribed or erased
  recipient gets nothing; RFC 8058 headers present and the one-click POST works; no address in
  any log line (log-guard test); a member never gets a mail about their own comment.
- Depends on: C4, C6.

**C9. export and erasure**
- Scope: section 13: the admin's export and erase, the reader's data request, page, per-comment
  delete and erase.
- Acceptance: the export holds every comment of the address in every status and nothing
  hashed; erase leaves tombstones exactly where approved replies exist and deletes everything
  else including outbox rows, in one transaction; the data request answers the same for any
  address; an editor can't erase; `backups.md` states what erasure doesn't reach.
- Depends on: C2, C8.

**C10. plugin events and the comment guard**
- Scope: section 14: the trigger and the six events, `comments:read`, `comments:private`, the
  guard's declaration, validator vectors (both twins), dispatch on the write path, the stored
  verdict, the Plugins page's lines.
- Acceptance: no event row without a subscriber; events carry ids only (no name, text or
  address); a guard's hold and spam route the comment and show their reason; an error follows
  `on_error`; the budget is enforced; a webhook can't declare the guard; a guard can't approve.
- Depends on: C4, #458, #459.

**#500. comments site block (restated)**
- Scope: 11.1's block: `comments` with `title`, the placement rules, the collector's fetch,
  rendering `PostComments` from the context, the placeholder and Block tab.
- Acceptance: the chain per block as #352 requires; the block renders the same HTML as the
  code layout's component on the same post (parity test); refused in a part, a query and a
  post template; inert in a post's body; the fingerprint test pins the change.
- Depends on: C5, #489.

---

## 18. Decisions and open questions

The working answer is what this design assumes. Questions 1 to 9 change what the sub-issues
build, so they need an answer before filing.

1. **Who may comment.** Guests with a verified email in v1 (assumed, 3.1). Reader accounts
   (a `reader` role, public-site sessions) later, if at all. Answer: is that right, or do you
   want signed-in readers from the start?
2. **Default moderation.** Hold until a commenter has one approved comment (assumed, 4.2).
   The alternatives are hold everything or publish everything.
3. **Contributors.** No access to Discussion in v1 (assumed, 4.3). An option: read-only access
   to comments on posts they're credited on, with replies held for an editor.
4. **Names.** "Discussion" in the admin, "Comments" on the site, `reader_comments` in code, so
   the editor's "Comments" stays #192's (assumed, 1.1). The alternative renames #192's panel to
   "Notes" and calls this "Comments".
5. **Reader edits.** None in v1 (assumed, 6.4): delete and write again. An option: edit within
   15 minutes from the browser that posted, re-running the rules.
6. **Who sees a commenter's email.** Admins and editors (assumed, 7.1). An option: editors see
   it masked ("a…@example.com"), admins in full.
7. **CAPTCHA.** None in core; a plugin's job, after S13 (assumed, 5.1).
8. **Authors' mail default.** Daily digest (assumed, 8.3). Each one, or off, are the
   alternatives.
9. **Moderators editing readers' text.** Not allowed (assumed, 6.4).
10. **Threading.** Two levels shown, the real parent kept (assumed, 6.2); flat as a setting.
11. **Comment counts on lists and RSS.** Not in v1 (assumed, section 2). Adding them couples
    every approval to the lists' cache.
12. **Privacy page.** A Discussion setting picks the page the notice links to (assumed, 7.5).
    A site-wide "Privacy page" setting, shared with other features, may be better.
13. **Retention.** Unconfirmed 48 hours, spam and trash 30 days, pending 90, network hash 30
    days (assumed, 6.6). These could become settings later.
