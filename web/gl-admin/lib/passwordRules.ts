// The API's rules for a new password (#329) and the hint the forms show for
// them (#344). No imports, so the Astro account pages can render the hint on
// the server.
//
// PASSWORD_MIN is MinPasswordLength in api/password_utils.go, which every
// password binding applies (the new_password tag); passwordRules.test.ts reads
// both and fails if they disagree.
export const PASSWORD_MIN = 12

// The "At least N characters" hint under a new password: met once the
// password is long enough, with the count so far while it isn't. Counts code
// points, like Go's validator.
export function passwordRule(password: string): { met: boolean; text: string } {
  const length = [...password].length
  const met = length >= PASSWORD_MIN
  const soFar = length > 0 && !met ? ` (${length} so far)` : ""
  return { met, text: `At least ${PASSWORD_MIN} characters${soFar}` }
}

// The design's name for the other rule.
export const PASSWORD_DETAILS_RULE = "Not your email or name"

// Whether password is one of the account's details (email, username, full
// name), ignoring case and surrounding space, as passwordMatchesDetails in
// api/password_utils.go does. Empty details are skipped.
export function passwordMatchesDetails(password: string, details: readonly (string | null | undefined)[]): boolean {
  const typed = password.trim().toLowerCase()
  return details.some((detail) => {
    const value = (detail ?? "").trim().toLowerCase()
    return value !== "" && value === typed
  })
}
