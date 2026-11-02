package api

// Rules for a new password (#329), shared by every endpoint that sets one:
// accept invite, reset, self change, and an admin creating a user or setting
// someone's password. Login doesn't apply them, so a password set before the
// minimum went up keeps working until it is next changed.

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// MinPasswordLength is the shortest password, in characters (runes, like the
// validator's min=), that the API accepts when a password is set. Bindings use
// it through the new_password tag. The web's PASSWORD_MIN
// (web/gl-admin/lib/passwordRules.ts) is checked against it by its tests.
const MinPasswordLength = 12

// errPasswordMatchesDetails is the field message for a password equal to the
// account's email, username or full name.
const errPasswordMatchesDetails = "must not be your email, username or name"

// isLongEnoughPassword backs the new_password validator tag.
func isLongEnoughPassword(password string) bool {
	return utf8.RuneCountInString(password) >= MinPasswordLength
}

// newPasswordMessage is the field message for a too-short password.
func newPasswordMessage() string {
	return "must be at least " + strconv.Itoa(MinPasswordLength) + " characters"
}

// passwordMatchesDetails reports whether password is one of the account's
// details (email, username, full name), ignoring case and surrounding space.
// Empty details are skipped.
func passwordMatchesDetails(password string, details ...string) bool {
	password = strings.TrimSpace(password)
	for _, detail := range details {
		if detail = strings.TrimSpace(detail); detail != "" && strings.EqualFold(password, detail) {
			return true
		}
	}
	return false
}

// checkPasswordDetails writes a 400 field error and returns false when the
// new password is one of the account's details.
func checkPasswordDetails(c *gin.Context, password string, details ...string) bool {
	if !passwordMatchesDetails(password, details...) {
		return true
	}
	c.JSON(http.StatusBadRequest, gin.H{
		"error":  "password " + errPasswordMatchesDetails,
		"fields": map[string]string{"password": errPasswordMatchesDetails},
	})
	return false
}
