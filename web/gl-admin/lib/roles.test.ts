import { describe, expect, it } from "vitest"
import {
  canCreateContent,
  canEditPost,
  canEditPostDetails,
  canWriteMedia,
  isContentModerator,
  isSiteAdmin,
  postEditorAccess,
} from "./roles"

describe("isSiteAdmin", () => {
  it("allows only admins", () => {
    expect(isSiteAdmin("admin")).toBe(true)
    expect(isSiteAdmin("Admin")).toBe(true)
    expect(isSiteAdmin("editor")).toBe(false)
    expect(isSiteAdmin("contributor")).toBe(false)
    expect(isSiteAdmin(undefined)).toBe(false)
  })
})

describe("isContentModerator", () => {
  it("allows admins and editors, case-insensitively", () => {
    expect(isContentModerator("admin")).toBe(true)
    expect(isContentModerator("editor")).toBe(true)
    expect(isContentModerator("Editor")).toBe(true)
  })

  it("denies contributors and missing roles", () => {
    expect(isContentModerator("contributor")).toBe(false)
    expect(isContentModerator("")).toBe(false)
    expect(isContentModerator(null)).toBe(false)
    expect(isContentModerator(undefined)).toBe(false)
  })
})

describe("canCreateContent", () => {
  it("allows every content role (contributors create their own drafts, #135)", () => {
    expect(canCreateContent("admin")).toBe(true)
    expect(canCreateContent("editor")).toBe(true)
    expect(canCreateContent("Contributor")).toBe(true)
  })

  it("denies unknown and missing roles", () => {
    expect(canCreateContent("subscriber")).toBe(false)
    expect(canCreateContent("")).toBe(false)
    expect(canCreateContent(undefined)).toBe(false)
  })
})

// Role × ownership × status, mirroring api/auth_posts_test.go's matrix.
const admin = { id: 1, role: "admin" }
const editor = { id: 2, role: "editor" }
const owner = { id: 3, role: "contributor" }
const other = { id: 4, role: "contributor" }
const draft = { user_id: owner.id, post_status: "draft" }
const published = { user_id: owner.id, post_status: "published" }

describe("canEditPost (working copy)", () => {
  it.each([
    ["admin", admin, true],
    ["editor", editor, true],
    ["owner contributor", owner, true],
    ["other contributor", other, false],
  ])("%s → %s on drafts and published posts", (_name, user, allowed) => {
    expect(canEditPost(user, draft)).toBe(allowed)
    expect(canEditPost(user, published)).toBe(allowed)
  })

  it("denies a signed-out user and an unknown role that owns the post", () => {
    expect(canEditPost(null, draft)).toBe(false)
    expect(canEditPost({ id: owner.id, role: "subscriber" }, draft)).toBe(false)
  })
})

describe("canEditPostDetails (live fields)", () => {
  it.each([
    ["admin", admin, true, true],
    ["editor", editor, true, true],
    ["owner contributor", owner, true, false],
    ["other contributor", other, false, false],
  ])("%s → draft %s, published %s", (_name, user, onDraft, onPublished) => {
    expect(canEditPostDetails(user, draft)).toBe(onDraft)
    expect(canEditPostDetails(user, published)).toBe(onPublished)
  })
})

describe("canWriteMedia", () => {
  const file = { user_id: owner.id }
  it.each([
    ["admin", admin, true],
    ["editor", editor, true],
    ["owner contributor", owner, true],
    ["other contributor", other, false],
  ])("%s → %s", (_name, user, allowed) => {
    expect(canWriteMedia(user, file)).toBe(allowed)
  })

  it("denies a signed-out user and an unknown role that owns the file", () => {
    expect(canWriteMedia(null, file)).toBe(false)
    expect(canWriteMedia({ id: owner.id, role: "subscriber" }, file)).toBe(false)
  })
})

describe("postEditorAccess", () => {
  it("create mode: any content role writes a draft, only moderators publish", () => {
    expect(postEditorAccess(editor, "create")).toEqual({ content: true, details: true, publish: true })
    expect(postEditorAccess(owner, "create")).toEqual({ content: true, details: true, publish: false })
    expect(postEditorAccess({ id: 9, role: "subscriber" }, "create")).toEqual({
      content: false,
      details: false,
      publish: false,
    })
  })

  it("edit mode: a contributor edits their own draft but never publishes", () => {
    expect(postEditorAccess(owner, "edit", draft)).toEqual({ content: true, details: true, publish: false })
  })

  it("edit mode: once published, the owner keeps the working copy but not the live fields", () => {
    expect(postEditorAccess(owner, "edit", published)).toEqual({ content: true, details: false, publish: false })
  })

  it("edit mode: someone else's post is view-only for a contributor", () => {
    expect(postEditorAccess(other, "edit", draft)).toEqual({ content: false, details: false, publish: false })
  })

  it("edit mode: moderators can do everything on any post", () => {
    for (const user of [admin, editor]) {
      expect(postEditorAccess(user, "edit", published)).toEqual({ content: true, details: true, publish: true })
    }
  })

  it("no user (signed out / not loaded yet) gets nothing", () => {
    expect(postEditorAccess(undefined, "edit", draft)).toEqual({ content: false, details: false, publish: false })
  })
})
