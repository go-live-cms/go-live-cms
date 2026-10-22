import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { useSelect } from "@gl-admin/utils/select"
import { authManager } from "@gl-admin/lib/auth"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import UserProfile from "@gl-admin/components/ui/user-profile/UserProfile"
import Icon from "@gl-admin/components/ui/Icon"
import SidebarPopup from "./SidebarPopup"
import SidebarItem from "./SidebarItem"

export default function SidebarUserProfile() {
  const user = useAuthUser()
  const navigate = useNavigate()
  const { open, setOpen, ref, handleSelectClick } = useSelect()
  const isDark = useGoLive()
  const navIconColor = isDark ? "#FFFFFF" : "#46484A"

  // Escape closes the popup (the mobile drawer leaves Escape to us while it's open)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, setOpen])

  const handleProfile = () => {
    setOpen(false)
    navigate("/profile")
  }

  // authManager.logout() revokes the session and clears auth; AuthGuard
  // then sends the user to the login page.
  const handleLogout = async () => {
    setOpen(false)
    await authManager.logout()
  }

  const footer = (
    <>
      <div className="version">v1.0.0</div>
      <div className="terms">Terms & Conditions</div>
    </>
  )

  return (
    <section className="sidebar-user-profile" ref={ref}>
      <UserProfile user={user} hover={false}>
        <Icon
          name="options"
          color={navIconColor}
          onClick={handleSelectClick}
          className={`user-profile__icon ${open ? "hovered" : ""}`}
        />
      </UserProfile>
      <SidebarPopup open={open} footer={footer}>
        <SidebarItem iconPath="user" name="My profile" onClick={handleProfile} />
        <SidebarItem iconPath="logout" name="Logout" onClick={handleLogout} />
      </SidebarPopup>
    </section>
  )
}
