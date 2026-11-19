import { Link } from "react-router-dom"

// The Settings menu (#330, #527): General's page sections, then Discussion, its own page
// after Editor (the redesign canvas's Settings board). On the General page the sections
// are in-page links; on Discussion they lead back to them.

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "accounts", label: "Accounts" },
  { id: "urls", label: "URLs & redirects" },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]

export const DISCUSSION_SETTINGS_PATH = "/settings/discussion"

type SettingsNavProps =
  // On the General page: the section in view, and the one picked.
  | { page: "general"; current: string; onPick: (id: SettingsSectionId) => void }
  | { page: "discussion" }

// The order the menu shows: Discussion right after Editor.
const ORDER = ["general", "editor", "discussion", "accounts", "urls"] as const

export default function SettingsNav(props: SettingsNavProps) {
  return (
    <nav className="gl-settings__nav" aria-label="Settings sections">
      {ORDER.map((id) => {
        if (id === "discussion") {
          return (
            <Link key={id} to={DISCUSSION_SETTINGS_PATH} aria-current={props.page === "discussion" ? "page" : undefined}>
              Discussion
            </Link>
          )
        }
        const section = SETTINGS_SECTIONS.find((s) => s.id === id)!
        if (props.page === "discussion") {
          return (
            <Link key={id} to={`/settings#gl-settings-${id}`}>
              {section.label}
            </Link>
          )
        }
        return (
          <a
            key={id}
            href={`#gl-settings-${id}`}
            aria-current={props.current === id ? "true" : undefined}
            onClick={() => props.onPick(id)}
          >
            {section.label}
          </a>
        )
      })}
    </nav>
  )
}
