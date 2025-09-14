// User management module providing comprehensive account administration and profile access.
//
// Supports complete user lifecycle management with role-based access controls, privacy protection,
// and administrative oversight capabilities. Implements secure authentication patterns and data integrity.
//
// # Module Structure
//
// - **users_routes.go**: Route registration with three-tier access control (public/auth/admin)
// - **users_handlers_read.go**: Profile retrieval with privacy controls and pagination
// - **users_handlers_write.go**: Account creation, updates, deletion with validation
// - **users_bindings.go**: Request validation structures for write operations
// - **users_presenters.go**: Public/private response formatting with email protection
// - **users_utils.go**: Normalization, validation, and security utilities
//
// # Access Control Matrix
//
// | Operation         | Public | Authenticated | Admin |
// |-------------------|--------|---------------|-------|
// | Get by username   | ✓      | ✓            | ✓     |
// | Get own profile   | -      | ✓            | ✓     |
// | Get by ID/email   | -      | -            | ✓     |
// | List all users    | -      | -            | ✓     |
// | Create user       | -      | -            | ✓     |
// | Update user       | -      | -            | ✓     |
// | Delete user       | -      | -            | ✓     |
//
// # Privacy Controls
//
// Email addresses and sensitive profile data are protected through differentiated response formats.
// Public endpoints return sanitized information while authenticated/admin access provides complete data.
//
// # Security Features
//
// - Secure password hashing with industry standards
// - Role-based middleware enforcement
// - Unique constraint validation for usernames/emails
// - Session invalidation on sensitive changes
// - Content transfer capabilities for account deletion
//
// # API Endpoints
//
// **Public Access:**
//   - `GET /users/username/{username}` - Public profile lookup
//
// **Authenticated Access:**
//   - `GET /users/me` - Current user's complete profile
//
// **Admin Access:**
//   - `GET /users` - List all users (paginated, sortable)
//   - `GET /users/{id}` - User profile by database ID
//   - `GET /users/email/{email}` - User lookup by email address
//   - `POST /users` - Create new user account
//   - `PUT /users/{id}` - Update existing user account
//   - `DELETE /users/{id}` - Delete user (with optional content transfer)
package api
