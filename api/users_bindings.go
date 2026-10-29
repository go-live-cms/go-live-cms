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
//   - Password: 6 characters to 72 bytes (bcrypt reads only 72), hashed before storage
//   - Role: Must be one of: admin, editor, contributor
//
// Security note: This endpoint is admin-only, and role values are restricted
// to the fixed list above (custom roles will replace this with a roles table).
type CreateUserRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Email    string `json:"email" binding:"required,max=254,email"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Password string `json:"password" binding:"required,min=6,max_bytes=72"`
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
//   - Password: 6 characters to 72 bytes if provided. The handler blocks every
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
	Password        string `json:"password" binding:"omitempty,min=6,max_bytes=72"`
	CurrentPassword string `json:"current_password" binding:"max_bytes=72"`
	Role            string `json:"role" binding:"omitempty,oneof=admin editor contributor"`
	// Author profile (#350). Absent keeps the stored value; "" clears it. The bio
	// is plain text, at most 300 characters after trimming (checked by the
	// handler); the website must be an http(s) URL.
	Bio     *string `json:"bio" binding:"omitempty,max=1000"`
	Website *string `json:"website" binding:"omitempty,max=2048"`
}

// DeleteUserRequest defines options for user account deletion.
//
// Provides content ownership transfer capabilities to handle user-generated content
// when accounts are deleted. Ensures data integrity and content preservation.
//
// Options:
//   - TransferToID: Optional user ID to receive ownership of deleted user's content
//   - If nil, content handling depends on system configuration
//
// Security: Only administrators can delete user accounts.
type DeleteUserRequest struct {
	TransferToID *int64 `json:"transfer_to_id"`
}
