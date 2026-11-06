/** Reloads the admin (the editor's "Reload" after a schema mismatch, #416). Its own module so tests can mock it. */
export function reloadPage(): void {
  window.location.reload()
}
