// users_bindings defines request structures for user management operations.
//
// Provides input validation and data binding for user-related HTTP requests.
// Each structure includes appropriate validation tags for security and data integrity.
//
// # Validation Strategy
//
// - **Required fields**: Essential data for account creation
// - **Optional fields**: Partial updates with omitempty validation
// - **Role restrictions**: Admin-only role assignment capabilities
// - **Security validation**: Email format, password strength, length limits
//
// # Request Types
//
// - **CreateUserRequest**: New account registration (admin-only)
// - **UpdateUserRequest**: Profile modifications (self or admin)
// - **DeleteUserRequest**: Account removal with content transfer options
package api

// CreateUserRequest defines the structure for new user account creation.
//
// Used exclusively by administrators to create user accounts with specific roles.
// All fields are required to ensure complete account setup.
//
// Validation rules:
//   - Username: 3-50 characters; after trimming, ASCII letters/digits only
//     (what login accepts, checked by the handler)
//   - Email: Valid email format (max 254), will be normalized to lowercase
//   - FullName: 2-100 characters for display purposes
//   - Password: MinPasswordLength characters to 72 bytes (bcrypt reads only 72),
//     not the user's email, username or name; hashed before storage
//   - Role: Must be one of: admin, editor, contributor
//
// Security note: This endpoint is admin-only, and role values are restricted
// to the fixed list above (custom roles will replace this with a roles table).
type CreateUserRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Email    string `json:"email" binding:"required,max=254,email"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Password string `json:"password" binding:"required,new_password,max_bytes=72"`
	Role     string `json:"role" binding:"required,oneof=admin editor contributor"`
}

// UpdateUserRequest defines the structure for user profile updates.
//
// Supports partial updates with all fields optional. Used by both users (self-update)
// and administrators (manage any user).
//
// Validation rules:
//   - Username: 3-50 characters if provided; a changed one must be ASCII letters/digits
//   - Email: Valid email format if provided
//   - FullName: 2-100 characters if provided
//   - Password: MinPasswordLength characters to 72 bytes if provided, not the
//     user's email, username or name (old or new). The handler blocks every
//     session the user holds in the same transaction as the change.
//   - CurrentPassword: The caller's existing password. The handler requires it
//     (and checks it) when a user changes their own password; it is ignored
//     for an admin resetting someone else's.
//   - Role: Must be one of admin, editor, contributor if provided (admin-only modification)
//   - Bio: plain text, at most 300 characters once trimmed (” clears it)
//   - Website: an http or https URL, at most 2048 characters (” clears it)
//
// Access control: Users can update all fields except role. Admins can update any field.
type UpdateUserRequest struct {
	Username        string `json:"username" binding:"omitempty,min=3,max=50"`
	Email           string `json:"email" binding:"omitempty,max=254,email"`
	FullName        string `json:"full_name" binding:"omitempty,min=2,max=100"`
	Password        string `json:"password" binding:"omitempty,new_password,max_bytes=72"`
	CurrentPassword string `json:"current_password" binding:"max_bytes=72"`
	Role            string `json:"role" binding:"omitempty,oneof=admin editor contributor"`
	// Author profile (#350). Absent keeps the stored value; "" clears it. The bio
	// is plain text, at most 300 characters after trimming (checked by the
	// handler); the website must be an http(s) URL.
	Bio     *string `json:"bio" binding:"omitempty,max=1000"`
	Website *string `json:"website" binding:"omitempty,max=2048"`
}

// DeleteUserRequest is the body of DELETE /users/:id (#333): who receives the
// posts and media the member owns. Required, even when they own nothing, so a
// removal always says where their content goes; it must be another existing user.
//
// Security: Only administrators can remove members.
type DeleteUserRequest struct {
	TransferToID *int64 `json:"transfer_to_id" binding:"required,min=1"`
}

// ChangeUserRoleRequest is the body of PUT /users/:id/role (#333).
type ChangeUserRoleRequest struct {
	Role string `json:"role" binding:"required,oneof=admin editor contributor"`
}

// ListMembersQuery is the Users screen's query string (GET /users, #333). q
// matches name, username or email (case-insensitive substring); role filters.
type ListMembersQuery struct {
	Q    string `form:"q" binding:"max=100"`
	Role string `form:"role" binding:"omitempty,oneof=admin editor contributor"`
}
