// User management module providing account administration and profile access.
//
// Supports the full user lifecycle with role-based access controls, privacy protection,
// and administrative oversight. Aligns with Sessions/Taxonomies module structure.
//
// # Module Structure
//
// - users_routes.go        — Route registration with three-tier access (public/auth/admin)
// - users_handlers_read.go — Profile retrieval, listing, pagination
// - users_handlers_write.go— Create/update/delete with validation
// - users_bindings.go      — Request DTOs and validation tags
// - users_presenters.go    — Public vs private responses (email privacy)
// - users_utils.go         — Normalization, sort validation, unique-violation helpers
//
// **Optional (Future)**
// - users_policy.go        — RBAC helpers
// - users_search.go        — Search by name functionality
//
// # Access Control Matrix
//
// | Operation         | Public | Authenticated (self) | Admin |
// |-------------------|:------:|:--------------------:|:-----:|
// | Get by username   |   ✓    |          ✓           |   ✓   |
// | Get own profile   |   -    |          ✓           |   ✓   |
// | Get by ID/email   |   -    |          -           |   ✓   |
// | List all users    |   -    |          -           |   ✓   |
// | Create user       |   -    |          -           |   ✓   |
// | Update user       |   -    |          ✓           |   ✓   |
// | Delete user       |   -    |          -           |   ✓   |
//
// # Privacy Controls
//
// Public endpoints return PublicUserResponse (no email). PrivateUserResponse (with email)
// is only returned to the user themselves or admins.
//
// # API Endpoints
//
// **Public**
//   - GET /users/:username         — Public profile (no email)
//
// **Authenticated**
//   - GET /users/me                — Current user's private profile
//
// **Admin**
//   - GET    /users                — List (limit/offset/sort)
//   - GET    /users/id/:id         — Lookup by ID
//   - GET    /users/email/:email   — Lookup by email
//   - POST   /users                — Create user
//   - PUT    /users/:id            — Update user (also allowed for self on auth routes if enabled)
//   - DELETE /users/:id            — Delete user (optional content transfer)
//
// # Sorting & Pagination
//
// - limit (default 10, max 100), offset (default 0)
// - sort: date_asc|date_desc|username_asc|username_desc|email_asc|email_desc|role_asc|role_desc|id_asc|id_desc
//
// # Status Codes
//
// - 200 OK         — Successful retrieval/update/delete
// - 201 Created    — User created
// - 400 Bad Request— Invalid params/body
// - 401 Unauthorized— Missing/invalid token
// - 403 Forbidden  — Insufficient role
// - 404 Not Found  — User not found
// - 409 Conflict   — Username/email already exists
// - 500 Internal   — DB or hashing failure
//
// # Security & Data Integrity
//
// - Emails normalized to lowercase; usernames trimmed
// - Public responses never include email
// - Unique constraints for username/email
// - (Planned) Session invalidation on password change; email verification
//
// # Implementation Notes
//
// - Register static routes (/me, /id/:id, /email/:email) before parameter route (/:username).
// - Use PublicUserResponse for public routes; PrivateUserResponse for self/admin.
//
// # Examples
//
// **GET /users/:username (public response)**
//
//	{
//	  "user": {
//	    "id": 123,
//	    "username": "johndoe",
//	    "full_name": "John Doe",
//	    "role": "user",
//	    "created_at": "2024-01-15T10:30:00Z"
//	  }
//	}
//
// **GET /users/me (private response)**
//
//	{
//	  "user": {
//	    "id": 123,
//	    "username": "johndoe",
//	    "email": "john@example.com",
//	    "full_name": "John Doe",
//	    "role": "user",
//	    "created_at": "2024-01-15T10:30:00Z"
//	  }
//	}
//
// **POST /users (request body)**
//
//	{
//	  "username": "newuser",
//	  "email": "new@example.com",
//	  "full_name": "New User",
//	  "password": "securepassword",
//	  "role": "user"
//	}
//
// # Future Enhancements (Planned)
//
// - Avatar & user meta
// - Search by name
// - Deactivation vs deletion
// - Email verification
package api
