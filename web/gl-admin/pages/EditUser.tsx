import React, { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { getUserById } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import UserForm from "@gl-admin/components/forms/UserForm"
import { AuthManager } from "@gl-admin/lib/auth"

export default function EditUser() {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const [user, setUser] = useState<User | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const accessToken = AuthManager.getInstance().getAccessToken() || ""

    useEffect(() => {
        const fetchUser = async () => {
            if (!id) {
                setError("No user ID provided")
                setLoading(false)
                return
            }

            try {
                const response = await getUserById(id, accessToken)
                setUser(response.user)
            } catch (err) {
                console.error("Error fetching user:", err)
                setError("Failed to load user")
            } finally {
                setLoading(false)
            }
        }

        fetchUser()
    }, [id, accessToken])

    const handleSuccess = (updatedUser: User) => {
        setUser(updatedUser)
    }

    const handleError = (errorMessage: string) => {
        setError(errorMessage)
    }

    if (loading) {
        return (
            <div className="user-form-page">
                <div className="page-header">
                    <h1>Loading User...</h1>
                </div>
                <div>Loading user data...</div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="user-form-page">
                <div className="page-header">
                    <h1>Error</h1>
                </div>
                <div className="message error">{error}</div>
                <button onClick={() => navigate("/users")} className="btn btn-secondary">
                    Back to Users
                </button>
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
                <button onClick={() => navigate("/users")} className="btn btn-secondary">
                    Back to Users
                </button>
            </div>
        )
    }

    return (
        <UserForm
            mode="edit"
            initialData={user}
            onSuccess={handleSuccess}
            onError={handleError}
        />
    )
}
