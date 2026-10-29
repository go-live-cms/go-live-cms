// A user's presence colour: the same one collaborators' carets use
// (postCollab.ts), id % 8 over the --presence-N tokens. Shared by the React
// Avatar and the account pages (no React), so it lives outside both.
export function presenceColor(id: number): string {
  return `var(--presence-${(Math.abs(Math.trunc(id)) % 8) + 1})`
}
