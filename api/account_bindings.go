// account_bindings defines request bodies for invitations and password reset.
//
// Username, full name and password rules match CreateUserRequest (an accepted
// invitation creates a user), so they can't drift apart.
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
	Token    string `json:"token" binding:"required"`
	Password string `json:"password" binding:"required,min=6"`
}

// PreviewInvitationRequest looks up what a valid invitation token is for.
type PreviewInvitationRequest struct {
	Token string `json:"token" binding:"required"`
}

// AcceptInvitationRequest redeems an invitation. The email and role come from
// the invitation, never from the request.
type AcceptInvitationRequest struct {
	Token    string `json:"token" binding:"required"`
	Username string `json:"username" binding:"required,min=3,max=50"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Password string `json:"password" binding:"required,min=6"`
}
