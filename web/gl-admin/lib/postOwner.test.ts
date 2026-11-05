import { describe, expect, it } from "vitest"
import { ApiError } from "@gl-admin/lib/api/errors"
import {
  canOwnPosts,
  canTransferPost,
  ownerLabel,
  replaceInBylineLabel,
  transferConfirmLine,
  transferError,
  transferredNotice,
} from "./postOwner"

// A post's owner (#353): the Owner field and the Transfer dialog.

const luan = { id: 1, username: "luan", full_name: "Luan" }
const ana = { id: 2, username: "ana", full_name: "Ana Costa" }
const marco = { id: 3, username: "marco", full_name: "" }
const me = { id: 1 }

describe("the Owner field", () => {
  it("names the owner, (you) when it's you", () => {
    expect(ownerLabel(luan, me)).toBe("Luan (you)")
    expect(ownerLabel(ana, me)).toBe("Ana Costa")
    expect(ownerLabel(marco, null)).toBe("marco")
  })

  it("offers Transfer to admins only, never in the trash", () => {
    expect(canTransferPost({ role: "admin" }, { post_status: "draft" })).toBe(true)
    expect(canTransferPost({ role: "Admin" }, { post_status: "published" })).toBe(true)
    expect(canTransferPost({ role: "editor" }, { post_status: "draft" })).toBe(false)
    expect(canTransferPost({ role: "contributor" }, { post_status: "draft" })).toBe(false)
    expect(canTransferPost(null, { post_status: "draft" })).toBe(false)
    expect(canTransferPost({ role: "admin" }, { post_status: "trash" })).toBe(false)
  })

  it("lets only active members (a content role) own posts", () => {
    expect(canOwnPosts({ role: "admin" })).toBe(true)
    expect(canOwnPosts({ role: "editor" })).toBe(true)
    expect(canOwnPosts({ role: "contributor" })).toBe(true)
    expect(canOwnPosts({ role: "user" })).toBe(false)
  })
})

describe("the Transfer dialog", () => {
  it("says the issue's confirm line when you own it", () => {
    expect(transferConfirmLine(ana, luan, me, false)).toBe("Ana Costa will own this post. You keep your place in the byline.")
    expect(transferConfirmLine(ana, luan, me, true)).toBe("Ana Costa will own this post. Ana Costa takes your place in the byline.")
  })

  it("names the old owner when it's someone else's", () => {
    expect(transferConfirmLine(luan, ana, me, false)).toBe("Luan will own this post. The byline stays as it is.")
    expect(transferConfirmLine(marco, ana, me, true)).toBe("marco will own this post. marco takes Ana Costa’s place in the byline.")
  })

  it("asks to replace you, or the owner, in the byline", () => {
    expect(replaceInBylineLabel(luan, me)).toBe("Also replace me in the byline")
    expect(replaceInBylineLabel(ana, me)).toBe("Also replace Ana Costa in the byline")
  })

  it("says what happened", () => {
    expect(transferredNotice(ana, false)).toBe("Ana Costa owns this post now.")
    expect(transferredNotice(ana, true)).toBe("Ana Costa owns this post now and is in the byline.")
  })

  it("explains the API's refusals", () => {
    const refused = (code: string, status: number) => new ApiError("Request failed.", status, null, code)
    expect(transferError(refused("invalid_owner", 400))).toBe("Choose an active member to own this post.")
    expect(transferError(refused("already_owner", 409))).toBe("They already own this post.")
    expect(transferError(refused("post_trashed", 409))).toBe("This post is in the trash. Restore it first.")
    expect(transferError(new ApiError("Something went wrong on the server.", 500))).toBe("Something went wrong on the server.")
  })
})
