import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Users (#333): the Posts owned and Last active columns, member search, and the row
// menu's Change role and Remove dialogs (who receives the posts).

const api = vi.hoisted(() => ({
    getUsers: vi.fn(),
    changeUserRole: vi.fn(),
    deleteUser: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/users", () => api)
vi.mock("@gl-admin/lib/api/invitations", () => ({
    listInvitations: () => Promise.resolve([]),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    createInvitation: vi.fn(),
}))

const me = vi.hoisted(() => ({ id: 1, username: "luan", full_name: "Luan", email: "luan@golive.dev", role: "admin", created_at: "" }))
const refreshUser = vi.hoisted(() => vi.fn())
vi.mock("@gl-admin/lib/auth", () => ({
    AuthManager: { getInstance: () => ({ getAccessToken: () => "token" }) },
    authManager: { getState: () => ({ user: me }), subscribe: () => () => {}, refreshUser },
}))

import Users from "./Users"
import { ApiError } from "@gl-admin/lib/api/errors"
import { toast } from "@gl-admin/components/ui/Toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const MEMBERS = [
    { ...me, posts_owned: 12, last_active_at: minutesAgo(1) },
    { id: 2, username: "ana", full_name: "Ana Costa", email: "ana@golive.dev", role: "editor", created_at: "", posts_owned: 9, last_active_at: minutesAgo(30) },
    { id: 3, username: "kenji", full_name: "Kenji T.", email: "kenji@golive.dev", role: "contributor", created_at: "", posts_owned: 0, last_active_at: null },
]

let container: HTMLDivElement
let root: Root

const settle = (ms = 0) =>
    act(async () => {
        if (ms) await new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })

const byLabel = (label: string, scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label
    )

const click = async (el: HTMLElement | undefined | null) => {
    expect(el).toBeTruthy()
    await act(async () => el!.click())
    await settle()
}

async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
    })
}

const rows = () =>
    Array.from(container.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim()))
const dialog = () => document.querySelector<HTMLElement>("[role='dialog'], [role='alertdialog']")
const menuItem = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")).find((b) => b.querySelector(".gl-menu__label")?.textContent === label)

beforeEach(async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    api.getUsers.mockReset().mockImplementation(async (params: { q?: string }) => {
        const q = params.q?.toLowerCase()
        const data = q ? MEMBERS.filter((m) => `${m.full_name} ${m.username} ${m.email}`.toLowerCase().includes(q)) : MEMBERS
        return { data, meta: { total: data.length } }
    })
    api.changeUserRole.mockReset()
    api.deleteUser.mockReset()
    refreshUser.mockReset()
    await act(async () =>
        root.render(
            <MemoryRouter>
                <Users />
            </MemoryRouter>
        )
    )
    await settle()
})

afterEach(() => {
    vi.restoreAllMocks()
    act(() => root.unmount())
    container.remove()
})

describe("members list", () => {
    it("shows posts owned and last active", () => {
        const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim())
        expect(headers).toEqual(expect.arrayContaining(["Name", "Role", "Posts owned", "Last active"]))
        const [luan, ana, kenji] = rows()
        expect(luan).toEqual(expect.arrayContaining(["12", "Now"]))
        expect(ana).toEqual(expect.arrayContaining(["9", "30 minutes ago"]))
        expect(kenji).toEqual(expect.arrayContaining(["0", "Never"]))
    })

    it("searches name, username and email once typing stops", async () => {
        const search = container.querySelector<HTMLInputElement>("input[type='search']")!
        expect(search.placeholder).toBe("Search members")
        await type(search, "kenji@")
        expect(api.getUsers).not.toHaveBeenCalledWith(expect.objectContaining({ q: "kenji@" }), expect.anything())
        await settle(300)
        expect(api.getUsers).toHaveBeenLastCalledWith(expect.objectContaining({ q: "kenji@" }), "token")
        expect(rows()).toHaveLength(1)

        await type(search, "nobody")
        await settle(300)
        expect(container.textContent).toContain("No members match “nobody”")
        await click(byLabel("Clear filters"))
        await settle(300)
        expect(rows()).toHaveLength(3)
    })

    it("never offers to remove yourself", async () => {
        await click(byLabel("More for Luan"))
        expect(menuItem("Remove")?.getAttribute("aria-disabled")).toBe("true")
    })
})

describe("change role", () => {
    it("opens from the role cell and sends the new role", async () => {
        const success = vi.spyOn(toast, "success")
        api.changeUserRole.mockResolvedValue({ user: { ...MEMBERS[1], role: "contributor" } })
        await click(byLabel("Role for Ana Costa: Editor. Change role"))
        expect(dialog()?.textContent).toContain("Change Ana Costa's role")
        const checked = dialog()!.querySelector<HTMLInputElement>("input[type='radio']:checked")!
        expect(checked.value).toBe("editor")
        expect(byLabel("Change role", dialog()!)!.disabled).toBe(true) // nothing changed yet

        await click(dialog()!.querySelector<HTMLInputElement>("input[value='contributor']"))
        await click(byLabel("Change role", dialog()!))
        expect(api.changeUserRole).toHaveBeenCalledWith(2, "contributor")
        expect(dialog()).toBeNull()
        expect(success).toHaveBeenCalledWith("Ana Costa is now a contributor.", expect.anything())
        expect(refreshUser).not.toHaveBeenCalled()
    })

    it("explains why the last admin can't be demoted, and warns before demoting yourself", async () => {
        api.changeUserRole.mockRejectedValue(new ApiError("Request failed.", 409, null, "last_admin"))
        await click(byLabel("More for Luan"))
        await click(menuItem("Change role"))
        await click(dialog()!.querySelector<HTMLInputElement>("input[value='editor']"))
        expect(dialog()!.textContent).toContain("You'll lose access to Users, Themes and Settings.")
        await click(byLabel("Change role", dialog()!))
        expect(dialog()!.textContent).toContain("Luan is the only administrator. Make someone else an administrator first.")
    })
})

describe("remove member", () => {
    it("asks who receives their posts, you by default, and removes them", async () => {
        const success = vi.spyOn(toast, "success")
        api.deleteUser.mockResolvedValue({ posts_reassigned: 9 })
        await click(byLabel("More for Ana Costa"))
        await click(menuItem("Remove"))
        const box = dialog()!
        expect(box.getAttribute("role")).toBe("alertdialog")
        expect(box.textContent).toContain("Remove Ana Costa?")
        expect(box.textContent).toContain("Their 9 posts and the media they uploaded will belong to:")
        const picker = box.querySelector<HTMLInputElement>("input[role='combobox']")!
        expect(picker.value).toBe("Luan (you)")

        await click(byLabel("Remove member", box))
        expect(api.deleteUser).toHaveBeenCalledWith(2, 1)
        expect(dialog()).toBeNull()
        expect(success).toHaveBeenCalledWith("Ana Costa was removed. 9 posts now belong to Luan.", expect.anything())
    })

    it("lets you pick someone else, and keeps the dialog open on a refusal", async () => {
        api.deleteUser.mockRejectedValue(new ApiError("Request failed.", 400, null, "invalid_transfer_target"))
        await click(byLabel("More for Kenji T."))
        await click(menuItem("Remove"))
        const box = dialog()!
        expect(box.textContent).toContain("They own no posts.")
        const picker = box.querySelector<HTMLInputElement>("input[role='combobox']")!
        await type(picker, "ana")
        await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
        await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
        await settle()
        expect(picker.value).toBe("Ana Costa")

        await click(byLabel("Remove member", box))
        expect(api.deleteUser).toHaveBeenCalledWith(3, 2)
        expect(dialog()!.textContent).toContain("Choose another member to receive their posts.")
    })

    it("offers every member, past the API's 100-per-page cap", async () => {
        const many = Array.from({ length: 150 }, (_, i) => ({
            id: 100 + i,
            username: `m${String(i).padStart(3, "0")}`,
            full_name: `Member ${String(i).padStart(3, "0")}`,
            email: `m${i}@golive.dev`,
            role: "contributor",
            created_at: "",
        }))
        const everyone = [...MEMBERS, ...many]
        api.getUsers.mockImplementation(async ({ limit = 8, offset = 0 }: { limit?: number; offset?: number }) => ({
            data: everyone.slice(offset, offset + limit),
            meta: { total: everyone.length },
        }))
        await click(byLabel("More for Ana Costa"))
        await click(menuItem("Remove"))
        const picker = dialog()!.querySelector<HTMLInputElement>("input[role='combobox']")!
        await type(picker, "Member 149")
        await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
        await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
        await settle()
        expect(picker.value).toBe("Member 149")
        expect(api.getUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, offset: 100 }))
    })
})
