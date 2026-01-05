import React, { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { getUserById } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import UserForm from "@gl-admin/components/forms/UserForm"
import { AuthManager } from "@gl-admin/lib/auth"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"

export default function EditUser() {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const [user, setUser] = useState<User | null>(null)
    const [loading, setLoading] = useState(true)
    const accessToken = AuthManager.getInstance().getAccessToken() || ""
    const { toasts, showError, removeToast } = useToast()

    useEffect(() => {
        const fetchUser = async () => {
            if (!id) {
                showError("No user ID provided")
                setLoading(false)
                navigate("/users")
                return
            }

            try {
                const response = await getUserById(id, accessToken)
                setUser(response.user)
            } catch (err) {
                console.error("Error fetching user:", err)
                showError("Failed to load user. Please try again.")
                navigate("/users")
            } finally {
                setLoading(false)
            }
        }

        fetchUser()
    }, [id, accessToken])

    const handleSuccess = (updatedUser: User) => {
        setUser(updatedUser)
    }

    if (loading) {
        return (
            <div className="user-form-page">
                <div className="page-header">
                    <h1>Loading User...</h1>
                </div>
                <div>Loading user data...</div>
                <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
            </div>
        )
    }

    if (!user) {
        return (
            <div className="user-form-page">
                <div className="page-header">
                    <h1>User Not Found</h1>
                </div>
                <div className="message error">The requested user could not be found.</div>
                <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
            </div>
        )
    }

    return (
        <>
            <UserForm
                mode="edit"
                initialData={user}
                onSuccess={handleSuccess}
            />
            <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
        </>
    )
}
