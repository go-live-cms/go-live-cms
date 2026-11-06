package api

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The block comment rules (#192, auth_posts.go) for every role, without a database.
func TestCommentRules(t *testing.T) {
	admin := db.User{ID: 1, Role: RoleAdmin}
	editor := db.User{ID: 2, Role: RoleEditor}
	owner := db.User{ID: 3, Role: RoleContributor}
	other := db.User{ID: 4, Role: RoleContributor}
	stranger := db.User{ID: 5, Role: "subscriber"}

	draft := db.Post{ID: 10, UserID: owner.ID, PostStatus: "draft"}
	published := db.Post{ID: 11, UserID: owner.ID, PostStatus: "published"}
	trashed := db.Post{ID: 12, UserID: owner.ID, PostStatus: postStatusTrash}

	by := func(u db.User) sql.NullInt64 { return sql.NullInt64{Int64: u.ID, Valid: true} }
	removed := sql.NullInt64{}

	t.Run("comment = read access, not in the trash", func(t *testing.T) {
		for _, c := range []struct {
			user db.User
			post db.Post
			want bool
		}{
			{admin, draft, true}, {editor, draft, true}, {owner, draft, true}, {other, draft, false},
			{other, published, true}, {stranger, published, false},
			{admin, trashed, false}, {owner, trashed, false},
		} {
			require.Equal(t, c.want, canCommentOnPost(c.user, c.post), "%s on %s", c.user.Role, c.post.PostStatus)
		}
	})

	t.Run("resolve = edits the working copy, or started the thread", func(t *testing.T) {
		require.True(t, canResolveCommentThread(other, published, by(other), false))
		require.False(t, canResolveCommentThread(other, published, by(editor), false))
		require.True(t, canResolveCommentThread(other, published, by(editor), true), "a granted collaborator")
		require.False(t, canResolveCommentThread(other, published, removed, false))
		require.False(t, canResolveCommentThread(other, draft, by(other), false), "can't read the draft")
		require.False(t, canResolveCommentThread(admin, trashed, by(admin), true))
	})

	t.Run("edit = the author only", func(t *testing.T) {
		require.True(t, canEditComment(other, published, by(other)))
		require.False(t, canEditComment(admin, published, by(other)))
		require.False(t, canEditComment(admin, published, removed))
		require.False(t, canEditComment(owner, trashed, by(owner)))
	})

	t.Run("delete = the author or a moderator", func(t *testing.T) {
		require.True(t, canDeleteComment(other, published, by(other)))
		require.True(t, canDeleteComment(editor, published, by(other)))
		require.True(t, canDeleteComment(admin, published, removed))
		require.False(t, canDeleteComment(owner, published, by(other)), "the post's owner isn't a moderator")
		require.False(t, canDeleteComment(editor, trashed, by(editor)))
	})
}

func TestNormalizeCommentBody(t *testing.T) {
	body, err := normalizeCommentBody("  hi\n there \t")
	require.NoError(t, err)
	require.Equal(t, "hi\n there", body)
	for _, bad := range []string{"", "   ", "a\x00", strings.Repeat("a", commentBodyMax+1)} {
		_, err := normalizeCommentBody(bad)
		require.Error(t, err, "%q", bad)
	}
	require.True(t, commentBlockIDPattern.MatchString("blk-ok-0000001"))
	require.False(t, commentBlockIDPattern.MatchString("blk ok 0000001"))
}
