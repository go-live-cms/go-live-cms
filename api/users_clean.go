// Package api — Users & Account Management Module
//
// User account system with role-based access control (RBAC), profile management,
// and privacy controls. Handles authentication, authorization, and account lifecycle.
//
// # Purpose & Scope
//
// - **Account Management**: User registration, profile updates, account deletion
// - **Role-Based Access**: Admin, moderator, and user role enforcement
// - **Privacy Controls**: Public vs private profile data based on access level
// - **Security**: Password management, session invalidation, email privacy
//
// # RBAC Matrix
//
// **Public Access**:
//   - GET /users/:username → public profile (no email)
//
// **Authenticated Users**:
//   - GET /users/me → own private profile
//   - PUT /users/:id → update self or admin manages any
//   - DELETE /users/:id → admin only (optional self-delete)
//
// **Admin Only**:
//   - POST /users → create user accounts
//   - GET /users → list all users with pagination
//   - GET /users/id/:id → fetch by ID
//   - GET /users/email/:email → fetch by email (sensitive)
//   - Role management and user transfers
//
// # API Endpoints
//
// **Public**: GET /users/:username
// **Authenticated**: GET /users/me, PUT /users/:id, DELETE /users/:id
// **Admin**: POST /users, GET /users, GET /users/id/:id, GET /users/email/:email
//
// # Security Features
//
// - Email normalization and privacy protection
// - Role-based field access (admin can set roles, users cannot)
// - Password changes invalidate all user sessions
// - Unique constraint violation handling with proper error codes
// - Content ownership transfer on account deletion
//
// # Response Privacy
//
// **PublicUserResponse**: username, full_name, role, created_at (no email)
// **PrivateUserResponse**: includes email for self/admin access
//
// # Module Structure
//
// - **users_routes.go**: Route registration with role middleware
// - **users_bindings.go**: Request structures with validation
// - **users_presenters.go**: Public/private response formatters
// - **users_handlers_read.go**: Profile retrieval and listing
// - **users_handlers_write.go**: Account creation, updates, deletion
// - **users_utils.go**: Normalization, validation, role guards
//
// # Status Codes
//
// - 200 OK: Successful operations
// - 201 Created: User account created
// - 400 Bad Request: Validation errors, malformed requests
// - 401 Unauthorized: Authentication required
// - 403 Forbidden: Insufficient permissions for operation
// - 404 Not Found: User not found
// - 409 Conflict: Username/email already exists
// - 500 Internal Server Error: Database or system errors
package api
