// account_bindings defines request bodies for invitations and password reset.
//
// Username, full name and password rules match CreateUserRequest (an accepted
// invitation creates a user), so they can't drift apart. new_password is the
// shared minimum (MinPasswordLength, password_utils.go). Bound with bindJSON
// (#139): unknown fields are rejected, and every string has a max.
package api

// CreateInvitationRequest invites an email address with a role (admin only).
// Roles are the same fixed list user creation accepts.
type CreateInvitationRequest struct {
	Email string `json:"email" binding:"required,email,max=254"`
	Role  string `json:"role" binding:"required,oneof=admin editor contributor"`
}

// ForgotPasswordRequest asks for a password reset email.
type ForgotPasswordRequest struct {
	Email string `json:"email" binding:"required,email,max=254"`
}

// ResetPasswordRequest redeems a password reset token.
type ResetPasswordRequest struct {
	Token    string `json:"token" binding:"required,max=64"`
	Password string `json:"password" binding:"required,new_password,max_bytes=72"`
}

// PreviewInvitationRequest looks up what a valid invitation token is for.
type PreviewInvitationRequest struct {
	Token string `json:"token" binding:"required,max=64"`
}

// AcceptInvitationRequest redeems an invitation. The email and role come from
// the invitation, never from the request.
type AcceptInvitationRequest struct {
	Token    string `json:"token" binding:"required,max=64"`
	Username string `json:"username" binding:"required,min=3,max=50"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Password string `json:"password" binding:"required,new_password,max_bytes=72"`
}

// RequestEmailChangeRequest asks to change the caller's own email (#334). The
// confirmation link goes to new_email; nothing changes until it is used.
type RequestEmailChangeRequest struct {
	CurrentPassword string `json:"current_password" binding:"required,max_bytes=72"`
	NewEmail        string `json:"new_email" binding:"required,email,max=254"`
}

// RegisterRequest is an open signup (#191), when Settings allows it. The same
// rules as AcceptInvitationRequest plus the email, which an invitation would fix.
// There is no password confirmation field: the page checks that, like the other
// account forms.
type RegisterRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Email    string `json:"email" binding:"required,email,max=254"`
	Password string `json:"password" binding:"required,new_password,max_bytes=72"`
}

// ConfirmSignupRequest redeems a signup confirmation token (#191).
type ConfirmSignupRequest struct {
	Token string `json:"token" binding:"required,max=64"`
}

// ConfirmEmailChangeRequest redeems an email change confirmation token.
type ConfirmEmailChangeRequest struct {
	Token string `json:"token" binding:"required,max=64"`
}
