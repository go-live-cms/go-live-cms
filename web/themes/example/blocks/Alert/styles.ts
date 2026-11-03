import type { ALERT_VARIANTS } from "./index"

export type AlertVariant = (typeof ALERT_VARIANTS)[number]

// Inline styles, so the block looks the same in the editor and on the public site, under
// any active theme (a post keeps its alerts when the site switches themes).
export const ALERT_STYLES: Record<AlertVariant, { bg: string; border: string; text: string; icon: string }> = {
  info: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", icon: "ℹ️" },
  success: { bg: "#d1fae5", border: "#10b981", text: "#065f46", icon: "✓" },
  warning: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", icon: "⚠️" },
  error: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b", icon: "✕" },
}
