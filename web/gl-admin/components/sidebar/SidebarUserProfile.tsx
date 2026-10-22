import { useEffect } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { useSelect } from "@gl-admin/utils/select"
import { logout } from "@gl-admin/lib/api/sessions"
import { authManager } from "@gl-admin/lib/auth"
import UserProfile from "@gl-admin/components/ui/user-profile/UserProfile"
import Icon from "@gl-admin/components/ui/Icon"
import SidebarPopup from "./SidebarPopup"
import SidebarItem from "./SidebarItem"

export default function SidebarUserProfile() {
  const auth = authManager.getState()
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

  const handleLogout = async () => {
    authManager.logout()
    await logout({ refresh_token: auth.refreshToken })
    setOpen(false)
    window.location.href = "/login"
  }

  const footer = (
    <>
      <div className="version">v1.0.0</div>
      <div className="terms">Terms & Conditions</div>
    </>
  )

  return (
    <section className="sidebar-user-profile" ref={ref}>
      <UserProfile user={auth.user} hover={false}>
        <Icon
          name="options"
          color={navIconColor}
          onClick={handleSelectClick}
          className={`user-profile__icon ${open ? "hovered" : ""}`}
        />
      </UserProfile>
      <SidebarPopup open={open} footer={footer}>
        <SidebarItem iconPath="logout" name="Logout" onClick={handleLogout} />
      </SidebarPopup>
    </section>
  )
}
