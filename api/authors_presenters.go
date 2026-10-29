// authors_presenters shapes the public author profile (#350).
//
// AuthorProfileResponse is the only user shape the public site gets: name,
// username, avatar, bio and website. It is built field by field from query
// rows that select nothing else, so email, role, ids, password data and
// sessions can't reach it. Don't reuse PublicUserResponse (it carries the
// role and the id) or embed db.User here.
package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// AuthorProfileResponse is an author as the public site shows them.
type AuthorProfileResponse struct {
	Username string `json:"username"`
	FullName string `json:"full_name"`
	// Always null until avatars exist (#334); the theme draws initials.
	Avatar  *string `json:"avatar"`
	Bio     string  `json:"bio"`
	Website string  `json:"website"`
}

// PublicAuthorListEntry is one author page in the sitemap listing.
type PublicAuthorListEntry struct {
	Username     string    `json:"username"`
	LastModified time.Time `json:"last_modified"`
}

func toAuthorProfile(username, fullName, bio, website string) AuthorProfileResponse {
	return AuthorProfileResponse{
		Username: username,
		FullName: fullName,
		Bio:      bio,
		Website:  website,
	}
}

func authorProfileFromRow(row db.GetPublicAuthorRow) AuthorProfileResponse {
	return toAuthorProfile(row.Username, row.FullName, row.Bio, row.Website)
}

func authorProfileFromPostRow(row db.ListPostAuthorProfilesRow) AuthorProfileResponse {
	return toAuthorProfile(row.Username, row.FullName, row.Bio, row.Website)
}
