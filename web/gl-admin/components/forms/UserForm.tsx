import React, { useEffect, useState } from "react"
import Input from "@gl-admin/components/ui/Input"
import Select, { type SelectOption } from "@gl-admin/components/ui/Select"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { createUser, updateUser } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { AuthManager } from "@gl-admin/lib/auth"

type UserFormMode = "create" | "edit"

type UserFormData = {
    username: string
    email: string
    full_name?: string
    role?: string
    password?: string
    confirm_password?: string
}

type UserFormProps = {
    mode: UserFormMode
    initialData?: User
    onSuccess?: (user: User) => void
    onError?: (message: string) => void
    roleOptions?: SelectOption[]
}

const DEFAULT_ROLE_OPTIONS: SelectOption[] = [
    { value: "admin", label: "Administrator" },
    { value: "editor", label: "Editor" },
    { value: "author", label: "Author" },
    { value: "viewer", label: "Viewer" },
]

function toUsername(seed?: string) {
    if (!seed) return ""
    return seed
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
}

function isValidEmail(email: string) {
    return /^\S+@\S+\.\S+$/.test(email)
}

export default function UserForm({
    mode,
    initialData,
    onSuccess,
    onError,
    roleOptions = DEFAULT_ROLE_OPTIONS,
}: UserFormProps) {
    const { toasts, showSuccess, showError, removeToast } = useToast()
    const [isSaving, setIsSaving] = useState(false)
    const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error" | null>(null)
    const accessToken = AuthManager.getInstance().getAccessToken() || ""

    const [formData, setFormData] = useState<UserFormData>({
        username: "",
        email: "",
        full_name: "",
        role: roleOptions?.[0]?.value,
        password: "",
        confirm_password: "",
    })

    useEffect(() => {
        if (mode === "edit" && initialData) {
            setFormData({
                username: (initialData as any).username || "",
                email: (initialData as any).email || "",
                full_name: (initialData as any).full_name || (initialData as any).name || "",
                role:
                    (initialData as any).role ||
                    ((Array.isArray((initialData as any).roles) && (initialData as any).roles[0]) || roleOptions?.[0]?.value),
                password: "",
                confirm_password: "",
            })
        }
    }, [mode, initialData])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault()
                handleSave()
            }
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [formData])

    function handleChange<K extends keyof UserFormData>(key: K, value: UserFormData[K]) {
        setFormData((prev) => ({ ...prev, [key]: value }))
    }

    function ensureUsername(seed?: string) {
        if (formData.username?.trim()) return formData.username
        if (seed) return toUsername(seed)
        if (formData.email) return toUsername(formData.email.split("@")[0] || "")
        if (formData.full_name) return toUsername(formData.full_name)
        return ""
    }

    async function handleSave() {
        setIsSaving(true)
        setSaveStatus("saving")
        try {
            const email = (formData.email || "").trim()
            if (!email || !isValidEmail(email)) {
                throw new Error("Please provide a valid email.")
            }
            const username = ensureUsername()
            if (!username) {
                throw new Error("Username is required.")
            }

            const pwd = (formData.password || "").trim()
            const cpwd = (formData.confirm_password || "").trim()

            if (mode === "create") {
                if (!pwd || pwd.length < 8) {
                    throw new Error("Password must be at least 8 characters.")
                }
                if (pwd !== cpwd) {
                    throw new Error("Passwords do not match.")
                }
            } else {
                if (pwd || cpwd) {
                    if (pwd.length < 8) {
                        throw new Error("Password must be at least 8 characters.")
                    }
                    if (pwd !== cpwd) {
                        throw new Error("Passwords do not match.")
                    }
                }
            }

            const payload: Partial<User> & { password?: string } = {
                username,
                email,
                full_name: formData.full_name?.trim() || undefined,
                role: formData.role,
            }
            if (pwd) {
                payload.password = pwd
            }

            let result: { user: User }
            if (mode === "create") {
                result = await createUser(payload as any, accessToken)
                showSuccess("User created successfully!")
            } else if (initialData) {
                result = await updateUser((initialData as any).id, payload as any, accessToken)
                showSuccess("User updated successfully!")
            } else {
                throw new Error("Invalid edit operation: no initial user data.")
            }

            setSaveStatus("saved")
            onSuccess?.(result.user)
        } catch (err) {
            console.error("Error saving user:", err)
            const message = err instanceof Error ? err.message : "Failed to save user. Please try again."
            showError(message)
            setSaveStatus("error")
            onError?.(message)
        } finally {
            setIsSaving(false)
            setTimeout(() => setSaveStatus(null), 2500)
        }
    }

    return (
        <div className="user-form">
            <div className="user-form__bar mb-4 flex items-center gap-3">
                <div className="font-semibold">
                    {mode === "create" ? "Create User" : "Edit User"}
                </div>
                <div className={saveStatus === "error" ? "text-red-600" : "text-gray-500"}>
                    {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Error" : ""}
                </div>
                <div className="ml-auto flex gap-2">
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={isSaving}
                        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100"
                        aria-disabled={isSaving}
                        title="Save (Ctrl/Cmd+S)"
                    >
                        {isSaving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>

            {/* Main form fields */}
            <div className="user-form__fields grid grid-cols-1 gap-4 md:grid-cols-2">
                <Input
                    title="Email"
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={(e: any) => handleChange("email", e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <Input
                    title="Username"
                    type="text"
                    name="username"
                    value={formData.username}
                    onChange={(e: any) => handleChange("username", e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <Input
                    title="Full name"
                    type="text"
                    name="full_name"
                    value={formData.full_name || ""}
                    onChange={(e: any) => handleChange("full_name", e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <Input
                    title="Password"
                    type="password"
                    name="password"
                    value={formData.password || ""}
                    onChange={(e: any) => handleChange("password", e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <Input
                    title="Confirm password"
                    type="password"
                    name="confirm_password"
                    value={formData.confirm_password || ""}
                    onChange={(e: any) => handleChange("confirm_password", e.currentTarget?.value ?? e.target?.value ?? "")}
                />

                <div className="flex gap-4 md:col-span-2">
                    <div className="flex-1">
                        <Select
                            label="Role"
                            options={roleOptions}
                            value={formData.role || ""}
                            onChange={(val) => handleChange("role", val)}
                        />
                    </div>
                </div>
            </div>

            <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
        </div>
    )
}