// The API's password minimum and the hint the forms show for it (#344). No
// imports, so the Astro account pages can render the hint on the server.
//
// PASSWORD_MIN is the `min=` on every password binding in the API
// (api/account_bindings.go, api/users_bindings.go); passwordRules.test.ts reads
// those files and fails if they disagree.
export const PASSWORD_MIN = 6

// The "At least N characters" hint under a new password: met once the
// password is long enough, with the count so far while it isn't. Counts code
// points, like Go's validator.
export function passwordRule(password: string): { met: boolean; text: string } {
  const length = [...password].length
  const met = length >= PASSWORD_MIN
  const soFar = length > 0 && !met ? ` (${length} so far)` : ""
  return { met, text: `At least ${PASSWORD_MIN} characters${soFar}` }
}
