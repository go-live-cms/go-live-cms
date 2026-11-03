package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The schedule routes' branches (#147) with the mock store; the real database
// flows are in scheduled_publish_test.go.

func mustLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	require.NoError(t, err)
	return loc
}

// TestSiteLocalToUTC: the dialog's wall-clock time in the site's zone becomes
// the instant it names, DST included. A time the clocks skip is refused; one
// that happens twice is the first.
func TestSiteLocalToUTC(t *testing.T) {
	for _, tc := range []struct {
		name, zone, local string
		want              string
		err               error
	}{
		{name: "SaoPaulo", zone: "America/Sao_Paulo", local: "2026-11-03T09:00", want: "2026-11-03T12:00:00Z"},
		{name: "UTC", zone: "UTC", local: "2026-11-03T09:00", want: "2026-11-03T09:00:00Z"},
		{name: "NewYorkWinter", zone: "America/New_York", local: "2026-01-15T09:00", want: "2026-01-15T14:00:00Z"},
		{name: "NewYorkSummer", zone: "America/New_York", local: "2026-07-15T09:00", want: "2026-07-15T13:00:00Z"},
		// 2026-03-08 02:00 EST jumps to 03:00 EDT: 02:30 never happens.
		{name: "SpringForwardGap", zone: "America/New_York", local: "2026-03-08T02:30", err: errNonexistentLocalTime},
		// Just around the gap.
		{name: "BeforeGap", zone: "America/New_York", local: "2026-03-08T01:59", want: "2026-03-08T06:59:00Z"},
		{name: "AfterGap", zone: "America/New_York", local: "2026-03-08T03:00", want: "2026-03-08T07:00:00Z"},
		// 2026-11-01 02:00 EDT falls back to 01:00 EST: 01:30 happens twice; the first is EDT.
		{name: "FallBackTwice", zone: "America/New_York", local: "2026-11-01T01:30", want: "2026-11-01T05:30:00Z"},
		// Southern hemisphere: Sydney springs forward on 2026-10-04 at 02:00.
		{name: "SydneyGap", zone: "Australia/Sydney", local: "2026-10-04T02:15", err: errNonexistentLocalTime},
		{name: "SydneyFallBack", zone: "Australia/Sydney", local: "2026-04-05T02:30", want: "2026-04-04T15:30:00Z"},
		// A 30-minute shift.
		{name: "LordHoweFallBack", zone: "Australia/Lord_Howe", local: "2026-04-05T01:45", want: "2026-04-04T14:45:00Z"},
		{name: "Garbage", zone: "UTC", local: "tomorrow at nine", err: errInvalidLocalTime},
		{name: "Seconds", zone: "UTC", local: "2026-11-03T09:00:00", err: errInvalidLocalTime},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := siteLocalToUTC(tc.local, mustLocation(t, tc.zone))
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, got.Format(time.RFC3339))
			require.Equal(t, time.UTC, got.Location())
		})
	}
}

// secondSundayOfMarch is the US spring-forward date of year, "YYYY-MM-DD".
func secondSundayOfMarch(year int) string {
	day := time.Date(year, 3, 1, 12, 0, 0, 0, time.UTC)
	for day.Weekday() != time.Sunday {
		day = day.AddDate(0, 0, 1)
	}
	return day.AddDate(0, 0, 7).Format("2006-01-02")
}

func TestScheduledPublishRetryAfter(t *testing.T) {
	require.Equal(t, 30*time.Second, scheduledPublishRetryAfter(0))
	require.Equal(t, 30*time.Second, scheduledPublishRetryAfter(1))
	require.Equal(t, time.Minute, scheduledPublishRetryAfter(2))
	require.Equal(t, 10*time.Minute, scheduledPublishRetryAfter(5))
	require.Equal(t, 10*time.Minute, scheduledPublishRetryAfter(500))
}

var scheduleContributor = db.User{ID: 7, Username: "contrib", Role: RoleContributor}

func scheduleMockRequest(t *testing.T, server *Server, user db.User, method string, postID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, fmt.Sprintf("/api/v1/posts/%d/schedule", postID), strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestSchedulePostAPI(t *testing.T) {
	nextYear := time.Now().Year() + 1
	local := fmt.Sprintf("%d-06-15T09:00", nextYear)
	wantUTC := time.Date(nextYear, 6, 15, 12, 0, 0, 0, time.UTC) // São Paulo is UTC−3 all year
	future := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	scheduled := db.Post{ID: 1, PostStatus: postStatusScheduled, PublishAt: sql.NullTime{Time: wantUTC, Valid: true}}

	for _, tc := range []struct {
		name   string
		user   db.User
		method string
		body   string
		stubs  func(store *mockdb.MockStore)
		want   int
		check  func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name: "ContributorCannotSchedule", user: scheduleContributor, method: http.MethodPut,
			body: `{"publish_at":"` + future.Format(time.RFC3339) + `"}`, want: http.StatusForbidden,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).Times(0)
			},
		},
		{
			name: "ContributorCannotCancel", user: scheduleContributor, method: http.MethodDelete, want: http.StatusForbidden,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().CancelPostSchedule(gomock.Any(), gomock.Any()).Times(0)
			},
		},
		{
			name: "LocalTimeInSiteZone", user: publishEditor, method: http.MethodPut, body: `{"local":"` + local + `"}`, want: http.StatusOK,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteTimezone: "America/Sao_Paulo"}, nil)
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.SchedulePostParams) (db.Post, error) {
						require.Equal(t, int64(1), arg.ID)
						require.True(t, wantUTC.Equal(arg.PublishAt), arg.PublishAt.String())
						require.Equal(t, sql.NullInt64{Int64: publishEditor.ID, Valid: true}, arg.ScheduledBy)
						return scheduled, nil
					})
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Contains(t, recorder.Body.String(), `"publish_at":"`+wantUTC.Format(time.RFC3339)+`"`)
				require.Contains(t, recorder.Body.String(), `"post_status":"scheduled"`)
			},
		},
		{
			name: "InstantWithOffset", user: publishEditor, method: http.MethodPut,
			body: `{"publish_at":"` + future.In(mustLocation(t, "Asia/Tokyo")).Format(time.RFC3339) + `"}`, want: http.StatusOK,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.SchedulePostParams) (db.Post, error) {
						require.True(t, future.Equal(arg.PublishAt))
						require.Equal(t, time.UTC, arg.PublishAt.Location())
						return scheduled, nil
					})
			},
		},
		{
			// US clocks skip 02:00–03:00 on the second Sunday of March.
			name: "NonexistentLocalTime", user: publishEditor, method: http.MethodPut,
			body: `{"local":"` + secondSundayOfMarch(nextYear) + `T02:30"}`, want: http.StatusBadRequest,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteTimezone: "America/New_York"}, nil)
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Contains(t, recorder.Body.String(), "clocks change")
			},
		},
		{name: "BothTimes", user: publishEditor, method: http.MethodPut, body: `{"local":"` + local + `","publish_at":"` + future.Format(time.RFC3339) + `"}`, want: http.StatusBadRequest},
		{name: "NoTime", user: publishEditor, method: http.MethodPut, body: `{}`, want: http.StatusBadRequest},
		{name: "PastTime", user: publishEditor, method: http.MethodPut, body: `{"publish_at":"2020-01-01T00:00:00Z"}`, want: http.StatusBadRequest},
		{name: "TooFarAhead", user: publishEditor, method: http.MethodPut, body: `{"publish_at":"2999-01-01T00:00:00Z"}`, want: http.StatusBadRequest},
		{
			name: "BadLocal", user: publishEditor, method: http.MethodPut, body: `{"local":"soon"}`, want: http.StatusBadRequest,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteTimezone: "America/Sao_Paulo"}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Contains(t, recorder.Body.String(), `"local"`)
			},
		},
		{
			name: "PublishedPostConflict", user: publishEditor, method: http.MethodPut, body: `{"publish_at":"` + future.Format(time.RFC3339) + `"}`, want: http.StatusConflict,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(db.Post{ID: 1, PostStatus: postStatusPublished}, nil)
			},
		},
		{
			name: "MissingPost", user: publishEditor, method: http.MethodPut, body: `{"publish_at":"` + future.Format(time.RFC3339) + `"}`, want: http.StatusNotFound,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SchedulePost(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(db.Post{}, sql.ErrNoRows)
			},
		},
		{
			name: "Cancel", user: publishEditor, method: http.MethodDelete, want: http.StatusOK,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().CancelPostSchedule(gomock.Any(), int64(1)).Return(db.Post{ID: 1, PostStatus: "draft"}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Contains(t, recorder.Body.String(), `"publish_at":null`)
			},
		},
		{
			name: "CancelNotScheduled", user: publishEditor, method: http.MethodDelete, want: http.StatusConflict,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().CancelPostSchedule(gomock.Any(), int64(1)).Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(db.Post{ID: 1, PostStatus: "draft"}, nil)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, tc.user)
			if tc.stubs != nil {
				tc.stubs(store)
			}
			server := newTestServer(t, store)
			recorder := scheduleMockRequest(t, server, tc.user, tc.method, 1, tc.body)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.check != nil {
				tc.check(t, recorder)
			}
		})
	}
}

// TestPostStatusScheduledOnlyThroughScheduleRoute: "scheduled" is a valid
// status, but POST/PUT /posts can't set it (it needs a time). The editor
// sending a scheduled post's status back unchanged is fine.
func TestPostStatusScheduledOnlyThroughScheduleRoute(t *testing.T) {
	t.Run("Create", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, publishEditor)
		server := newTestServer(t, store)
		body := `{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":[1],"post_status":"scheduled"}`
		request := httptest.NewRequest(http.MethodPost, "/api/v1/posts", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, publishEditor.ID, publishEditor.Username, time.Minute)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), "/schedule")
	})

	for _, tc := range []struct {
		name     string
		existing string
		want     int
	}{
		{name: "DraftToScheduled", existing: "draft", want: http.StatusBadRequest},
		{name: "ScheduledUnchanged", existing: postStatusScheduled, want: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, publishEditor)
			existing := db.Post{ID: 1, Title: "Hello", PostStatus: tc.existing, Slug: "hello"}
			store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(existing, nil)
			if tc.want == http.StatusOK {
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Return(existing, nil)
			}
			server := newTestServer(t, store)
			request := httptest.NewRequest(http.MethodPut, "/api/v1/posts/1", strings.NewReader(`{"post_status":"scheduled"}`))
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, publishEditor.ID, publishEditor.Username, time.Minute)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// TestScheduledPostIsReadOnlyToItsContributor: scheduling is publishing in
// advance, so the owner's later edits would go live unreviewed: a contributor
// can only watch their scheduled post (and can't change its live fields).
// Moderators keep full access.
func TestScheduledPostIsReadOnlyToItsContributor(t *testing.T) {
	owner := db.User{ID: 9, Role: RoleContributor}
	editor := db.User{ID: 2, Role: RoleEditor}
	for _, status := range []string{"draft", postStatusPublished, postStatusScheduled} {
		post := db.Post{ID: 1, UserID: owner.ID, PostStatus: status}
		require.Equal(t, status != postStatusScheduled, canEditPost(owner, post), status)
		require.Equal(t, status == "draft", canEditPostDetails(owner, post), status)
		require.True(t, canReadPostBlocks(owner, post), status)
		require.True(t, canEditPost(editor, post), status)
		require.True(t, canEditPostDetails(editor, post), status)
	}
}

func TestScheduleFailurePresenter(t *testing.T) {
	failedAt := time.Date(2026, 11, 3, 12, 0, 0, 0, time.FixedZone("BRT", -3*3600))
	next := failedAt.Add(time.Minute)
	post := db.Post{
		PostStatus:           postStatusScheduled,
		PublishAt:            sql.NullTime{Time: failedAt, Valid: true},
		PublishAttempts:      2,
		PublishFailedAt:      sql.NullTime{Time: failedAt, Valid: true},
		PublishNextAttemptAt: sql.NullTime{Time: next, Valid: true},
		PublishError:         sql.NullString{String: scheduledPublishCollabFlushFailed, Valid: true},
	}
	resp := toPostResponse(post)
	require.Equal(t, time.UTC, resp.PublishAt.Location())
	require.NotNil(t, resp.ScheduleFailure)
	require.Equal(t, int32(2), resp.ScheduleFailure.Attempts)
	require.True(t, next.Equal(*resp.ScheduleFailure.NextAttemptAt))

	// No failure recorded, or not scheduled any more: none shown.
	post.PublishFailedAt = sql.NullTime{}
	require.Nil(t, toPostResponse(post).ScheduleFailure)
	require.Nil(t, scheduleFailure(db.Post{PostStatus: postStatusPublished, PublishFailedAt: sql.NullTime{Time: failedAt, Valid: true}}))
	require.Nil(t, toPostResponse(db.Post{}).PublishAt)
}
