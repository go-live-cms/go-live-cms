import React from "react"
import UserForm from "@gl-admin/components/forms/UserForm"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"

export default function NewPost() {
    usePageTitle("New user")
    return <UserForm mode="create" />
}
