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
//   - Username: 3-50 characters, will be normalized by handlers
//   - Email: Valid email format, will be normalized to lowercase
//   - FullName: 2-100 characters for display purposes
//   - Password: Minimum 6 characters, will be hashed before storage
//   - Role: Must be one of: user, admin, moderator
//
// Security note: Only admins can set arbitrary roles during creation.
type CreateUserRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Email    string `json:"email" binding:"required,email"`
	FullName string `json:"full_name" binding:"required,min=2,max=100"`
	Password string `json:"password" binding:"required,min=6"`
	Role     string `json:"role" binding:"required,oneof=user admin moderator"`
}

// UpdateUserRequest defines the structure for user profile updates.
//
// Supports partial updates with all fields optional. Used by both users (self-update)
// and administrators (manage any user).
//
// Validation rules:
//   - Username: 3-50 characters if provided
//   - Email: Valid email format if provided
//   - FullName: 2-100 characters if provided
//   - Password: Minimum 6 characters if provided (triggers session invalidation)
//   - Role: Must be valid role if provided (admin-only modification)
//
// Access control: Users can update all fields except role. Admins can update any field.
type UpdateUserRequest struct {
	Username string `json:"username" binding:"omitempty,min=3,max=50"`
	Email    string `json:"email" binding:"omitempty,email"`
	FullName string `json:"full_name" binding:"omitempty,min=2,max=100"`
	Password string `json:"password" binding:"omitempty,min=6"`
	Role     string `json:"role" binding:"omitempty,oneof=user admin moderator"`
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
