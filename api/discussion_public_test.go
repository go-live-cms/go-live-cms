package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The public thread reads (#523, discussion_public.go) on a mock store: the failures and
// the presenter. discussion_public_db_test.go runs them against the database.

// expectDiscussionOff answers the discussion lookups every post read makes (#523): the
// site's settings and the post's type, comments off. Call it after a test's own
// GetSettings/GetPostType expectations (gomock takes the first that still matches).
func expectDiscussionOff(store *mockdb.MockStore) {
	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil).AnyTimes()
	store.EXPECT().GetPostType(gomock.Any(), gomock.Any()).Return(db.PostType{}, sql.ErrNoRows).AnyTimes()
}

func openDiscussionSettings() db.Setting {
	return db.Setting{CommentsEnabled: true, CommentsPerPage: 30, CommentsThreading: "replies", CommentsOrder: "oldest"}
}

func publicPostTypeWithComments() db.PostType {
	return db.PostType{Name: "post", Public: true, IsActive: true, Supports: []byte(`["title","comments"]`)}
}

func TestPublicCommentsFailures(t *testing.T) {
	published := db.Post{ID: 7, PostType: "post", PostStatus: postStatusPublished, Discussion: postDiscussionDefault}
	down := fmt.Errorf("db down")
	open := func(store *mockdb.MockStore) {
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(openDiscussionSettings(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostTypeWithComments(), nil)
	}
	root := db.GetPublicReaderCommentThreadRow{ID: 11, Shown: true, DisplayName: "Ana", Body: "Hi", CreatedAt: time.Now()}

	for _, tc := range []struct {
		name  string
		path  string
		setup func(*mockdb.MockStore)
		want  int
	}{
		{"PostLookup", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{}, down)
		}, http.StatusInternalServerError},
		{"Settings", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			s.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, down)
		}, http.StatusInternalServerError},
		{"PostType", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			s.EXPECT().GetSettings(gomock.Any()).Return(openDiscussionSettings(), nil)
			s.EXPECT().GetPostType(gomock.Any(), "post").Return(db.PostType{}, down)
		}, http.StatusInternalServerError},
		{"TypeGone", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			s.EXPECT().GetSettings(gomock.Any()).Return(openDiscussionSettings(), nil)
			s.EXPECT().GetPostType(gomock.Any(), "post").Return(db.PostType{}, sql.ErrNoRows)
		}, http.StatusNotFound},
		{"Count", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(0), down)
		}, http.StatusInternalServerError},
		{"CountThreads", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().CountPublicReaderCommentThreads(gomock.Any(), int64(7)).Return(int64(0), down)
		}, http.StatusInternalServerError},
		{"ListThreads", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().CountPublicReaderCommentThreads(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().ListPublicReaderCommentThreads(gomock.Any(), gomock.Any()).Return(nil, down)
		}, http.StatusInternalServerError},
		{"ListReplies", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().CountPublicReaderCommentThreads(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().ListPublicReaderCommentThreads(gomock.Any(), gomock.Any()).Return([]db.ListPublicReaderCommentThreadsRow{publicCommentRow(root)}, nil)
			s.EXPECT().ListPublicReaderCommentReplies(gomock.Any(), gomock.Any()).Return(nil, down)
		}, http.StatusInternalServerError},
		{"ListFlat", "/public/posts/7/comments", func(s *mockdb.MockStore) {
			s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			flat := openDiscussionSettings()
			flat.CommentsThreading = "flat"
			s.EXPECT().GetSettings(gomock.Any()).Return(flat, nil)
			s.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostTypeWithComments(), nil)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().ListPublicReaderCommentsFlat(gomock.Any(), gomock.Any()).Return(nil, down)
		}, http.StatusInternalServerError},
		{"Thread", "/public/posts/7/comments?thread=11", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().GetPublicReaderCommentThread(gomock.Any(), db.GetPublicReaderCommentThreadParams{ID: 11, PostID: 7}).Return(db.GetPublicReaderCommentThreadRow{}, down)
		}, http.StatusInternalServerError},
		{"ThreadReplies", "/public/posts/7/comments?thread=11", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
			s.EXPECT().GetPublicReaderCommentThread(gomock.Any(), gomock.Any()).Return(root, nil)
			s.EXPECT().ListPublicReaderCommentReplies(gomock.Any(), gomock.Any()).Return(nil, down)
		}, http.StatusInternalServerError},
		{"PageTooFar", "/public/posts/7/comments?page=2147483647", func(s *mockdb.MockStore) {
			open(s)
			s.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(1), nil)
		}, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.setup(store)
			recorder := serveSettingsGET(t, newTestServer(t, store), tc.path)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// The post read's discussion is optional on the page: with comments off for the site it
// reads the settings only (no type lookup, no count); a failed read leaves it null, never
// fails the post, and marks the answer no-store so the cache doesn't keep it.
func TestPublicPostReadDiscussion(t *testing.T) {
	published := db.Post{ID: 7, PostType: "post", PostStatus: postStatusPublished, Discussion: postDiscussionDefault}
	liveSettings := func(s *mockdb.MockStore) {
		s.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
		s.EXPECT().GetPostMetaByKey(gomock.Any(), gomock.Any()).Return(db.PostMetum{}, sql.ErrNoRows).AnyTimes()
		s.EXPECT().GetPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil).AnyTimes()
	}

	t.Run("OffForTheSite", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		liveSettings(store)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		store.EXPECT().GetPostType(gomock.Any(), gomock.Any()).Times(0)
		store.EXPECT().CountShownReaderComments(gomock.Any(), gomock.Any()).Times(0)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"discussion":{"state":"off","closes_at":null,"count":0}`)
		require.Empty(t, recorder.Header().Get("Cache-Control"))
	})

	t.Run("Open", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		liveSettings(store)
		store.EXPECT().GetSettings(gomock.Any()).Return(openDiscussionSettings(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostTypeWithComments(), nil)
		store.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(3), nil)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"discussion":{"state":"open","closes_at":null,"count":3}`)
	})

	t.Run("Failed", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		liveSettings(store)
		store.EXPECT().GetSettings(gomock.Any()).Return(openDiscussionSettings(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostTypeWithComments(), nil)
		store.EXPECT().CountShownReaderComments(gomock.Any(), int64(7)).Return(int64(0), fmt.Errorf("db down"))
		server := newTestServer(t, store)
		withMiniredis(t, server)
		recorder := serveSettingsGET(t, server, "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code, "the post renders without the section")
		require.Contains(t, recorder.Body.String(), `"discussion":null`)
		require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"), "and the answer isn't kept")
	})
}

// The presenter builds the public shape field by field: a hidden row is a bare
// placeholder whatever the row holds; a member's comment takes their name, avatar and
// badge; a member row without a name keeps the posted one.
func TestToPublicReaderComment(t *testing.T) {
	created := time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)
	hidden := toPublicReaderComment(publicCommentRow{
		ID: 3, RootID: sql.NullInt64{Int64: 1, Valid: true}, ParentID: sql.NullInt64{Int64: 2, Valid: true}, CreatedAt: created,
		Shown: false, DisplayName: "Leak", Body: "Leak", Edited: true, ByMember: true, MemberName: "Leak", MemberAvatar: "/uploads/x.png",
	})
	one, two := int64(1), int64(2)
	require.Equal(t, PublicReaderComment{ID: 3, RootID: &one, ParentID: &two, CreatedAt: created, Removed: true}, hidden)

	member := toPublicReaderComment(publicCommentRow{ID: 4, CreatedAt: created, Shown: true, DisplayName: "Posted", Body: "Hi",
		ByMember: true, MemberName: "Ana Costa", MemberAvatar: "/uploads/media/_avatars/a.png", MemberIsAuthor: true})
	require.Equal(t, "Ana Costa", member.Name)
	require.Equal(t, readerCommentBadgeAuthor, *member.Badge)
	require.Equal(t, "/uploads/media/_avatars/a.png", *member.Avatar)

	unnamed := toPublicReaderComment(publicCommentRow{ID: 5, CreatedAt: created, Shown: true, DisplayName: "Posted", Body: "Hi", ByMember: true})
	require.Equal(t, "Posted", unnamed.Name)
	require.Equal(t, readerCommentBadgeStaff, *unnamed.Badge)
	require.Nil(t, unnamed.Avatar)

	require.Equal(t, defaultCommentsPerPage, commentsPerPage(db.Setting{}))
	require.EqualValues(t, 12, commentsPerPage(db.Setting{CommentsPerPage: 12}))
}
