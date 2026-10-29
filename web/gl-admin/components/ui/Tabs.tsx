import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { nextRovingIndex, useStableId } from "@gl-admin/components/ui/a11y"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import "@gl-admin/assets/styles/components/ui/tabs.scss"

export type TabItem = {
  id: string
  label: ReactNode
  // Shown after the label in text-secondary; `null` shows a skeleton while loading.
  count?: number | null
  // When given, Tabs renders the selected tab's panel below the list.
  panel?: ReactNode
  disabled?: boolean
}

type TabsProps = {
  // Names the tab list for screen readers ("Views", "Settings sections").
  label: string
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  // automatic: arrow keys select as they move. manual: they only move focus, and
  // Enter/Space selects; use it when selecting a tab is slow (it loads data).
  activation?: "automatic" | "manual"
  className?: string
}

// Roving focus (#144): one Tab stop for the whole list, on the selected tab; arrow
// keys, Home and End move between tabs.
export default function Tabs({ label, tabs, value, onChange, activation = "automatic", className = "" }: TabsProps) {
  const baseId = useStableId("tabs")
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0)
  const selectedIndex = tabs.findIndex((t) => t.id === value)
  const tabStop = selectedIndex >= 0 && !tabs[selectedIndex].disabled ? selectedIndex : enabled[0]
  const selected = tabs[selectedIndex]

  // Keys reach the list only from a focused tab, so the focused one is where to move from.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = refs.current.findIndex((el) => el === document.activeElement)
    const next = nextRovingIndex(e.key, enabled.indexOf(current), enabled.length, "horizontal")
    if (next === null) return
    e.preventDefault()
    const index = enabled[next]
    refs.current[index]?.focus()
    if (activation === "automatic") onChange(tabs[index].id)
  }

  return (
    <div className={`gl-tabs ${className}`}>
      <div role="tablist" aria-label={label} className="gl-tabs__list" onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => {
          const isSelected = tab.id === value
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={tab.panel !== undefined ? `${baseId}-panel-${tab.id}` : undefined}
              tabIndex={i === tabStop ? 0 : -1}
              disabled={tab.disabled}
              className="gl-tabs__tab"
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
              {tab.count === null ? (
                <Skeleton width={16} height={10} />
              ) : (
                tab.count !== undefined && <span className="gl-tabs__count">{tab.count}</span>
              )}
            </button>
          )
        })}
      </div>
      {selected?.panel !== undefined && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${selected.id}`}
          aria-labelledby={`${baseId}-tab-${selected.id}`}
          tabIndex={0}
          className="gl-tabs__panel"
        >
          {selected.panel}
        </div>
      )}
    </div>
  )
}
