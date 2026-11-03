package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// SEO settings (#357): PUT /posts/:id/seo, the published SEO on /public/posts,
// noindex in the lists the sitemap reads, restore, the optional excerpt and the
// social crop.

func seoRequest(t *testing.T, server *Server, method, url, body string, user db.User) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestValidCanonicalURL(t *testing.T) {
	for _, ok := range []string{
		"",
		"https://example.com",
		"https://blog.golive.dev/guides/collaboration",
		"http://example.com:8080/a?b=c#d",
		"HTTPS://EXAMPLE.COM/x",
	} {
		require.NoError(t, validCanonicalURL(ok), ok)
	}
	for _, bad := range []string{
		"blog.golive.dev/guides collaboration", // the design's invalid example
		"blog.golive.dev/guides",
		"/relative/path",
		"//example.com/x",
		"ftp://example.com/x",
		"javascript:alert(1)",
		"mailto:a@example.com",
		"https://",
		"https://exa mple.com",
		"https://example.com/a b",
		"https://example.com/\tx",
		"https://user:pass@example.com/",
		`https:\\example.com`,
		"https://:443/x",
	} {
		require.ErrorIs(t, validCanonicalURL(bad), errInvalidCanonicalURL, bad)
	}
}

func TestUpdatePostSEO(t *testing.T) {
	contributor := db.User{ID: 2, Username: "contrib", Role: RoleContributor}
	url := "/api/v1/posts/7/seo"
	image := db.Medium{ID: 12, MimeType: "image/jpeg", MediaPath: "/uploads/media/share.jpg"}

	t.Run("Saves", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetMedia(gomock.Any(), int64(12)).Times(1).Return(image, nil)
		store.EXPECT().UpdatePostSEO(gomock.Any(), db.UpdatePostSEOParams{
			ID:             7,
			SeoTitle:       "Real-time collaboration in GoLive",
			SeoDescription: "Two people can now edit one post at the same time.",
			SocialImageID:  sql.NullInt64{Int64: 12, Valid: true},
			Noindex:        true,
			CanonicalUrl:   "https://blog.golive.dev/guides/collaboration",
		}).Times(1).DoAndReturn(func(_ any, arg db.UpdatePostSEOParams) (db.Post, error) {
			return db.Post{ID: 7, Title: "Post", SeoTitle: arg.SeoTitle, SeoDescription: arg.SeoDescription,
				SocialImageID: arg.SocialImageID, Noindex: arg.Noindex, CanonicalUrl: arg.CanonicalUrl}, nil
		})

		recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, url, `{
			"seo_title": "  Real-time collaboration in GoLive ",
			"seo_description": "Two people can now edit one post at the same time.\n",
			"social_image_id": 12, "noindex": true,
			"canonical_url": " https://blog.golive.dev/guides/collaboration"}`, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp struct {
			Post PostResponse `json:"post"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.NotNil(t, resp.Post.SEO)
		require.Equal(t, "Real-time collaboration in GoLive", resp.Post.SEO.SEOTitle)
		require.Equal(t, int64(12), *resp.Post.SEO.SocialImageID)
		require.True(t, resp.Post.SEO.Noindex)
	})

	t.Run("ClearsEverything", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
		store.EXPECT().UpdatePostSEO(gomock.Any(), db.UpdatePostSEOParams{ID: 7}).Times(1).Return(db.Post{ID: 7}, nil)
		recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, url, `{"social_image_id": null}`, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"social_image_id":null`)
	})

	for _, tc := range []struct {
		name  string
		url   string
		body  string
		user  db.User
		stubs func(store *mockdb.MockStore)
		want  int
	}{
		// Decision 7: contributors see the SEO fields read-only, on their own posts too.
		{"Contributor", url, `{"seo_title": "Mine"}`, contributor, func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusForbidden},
		{"InvalidCanonical", url, `{"canonical_url": "blog.golive.dev/guides collaboration"}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest},
		{"RelativeCanonical", url, `{"canonical_url": "/post/1"}`, publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"TitleNewline", url, `{"seo_title": "two\nlines"}`, publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"TitleTooLong", url, fmt.Sprintf(`{"seo_title": %q}`, strings.Repeat("a", 256)), publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"DescriptionTooLong", url, fmt.Sprintf(`{"seo_description": %q}`, strings.Repeat("é", 501)), publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"CanonicalTooLong", url, fmt.Sprintf(`{"canonical_url": "https://example.com/%s"}`, strings.Repeat("a", 2048)), publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"UnknownField", url, `{"og_image": 1}`, publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"ZeroImage", url, `{"social_image_id": 0}`, publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"ImageMissing", url, `{"social_image_id": 99}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetMedia(gomock.Any(), int64(99)).Return(db.Medium{}, sql.ErrNoRows)
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest},
		{"NotAnImage", url, `{"social_image_id": 13}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetMedia(gomock.Any(), int64(13)).Return(db.Medium{ID: 13, MimeType: "application/pdf"}, nil)
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest},
		{"ImageError", url, `{"social_image_id": 12}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetMedia(gomock.Any(), int64(12)).Return(db.Medium{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
		{"PostMissing", url, `{}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
		}, http.StatusNotFound},
		{"UpdateError", url, `{}`, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostSEO(gomock.Any(), gomock.Any()).Return(db.Post{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
		{"BadPost", "/api/v1/posts/x/seo", `{}`, publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubRoleLookup(store, tc.user)
			tc.stubs(store)
			recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, tc.url, tc.body, tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// seoPublishedPost is a published post whose SEO was edited after publishing:
// the row holds the working SEO, published_settings the published SEO.
func seoPublishedPost(socialImageID string) db.Post {
	post := editedPublishedPost()
	post.SeoTitle = "Working SEO title"
	post.SeoDescription = "Working SEO description"
	post.Noindex = false
	post.CanonicalUrl = "https://example.com/working"
	post.PublishedSettings = publishedSettings(`{"title": "Published title", "description": "Published excerpt",
		"featured_image": {"id": 5, "url": "/uploads/media/published.jpg"}, "term_ids": [],
		"seo_title": "Published SEO title", "seo_description": "Published SEO description",
		"social_image_id": ` + socialImageID + `, "noindex": true, "canonical_url": "https://example.com/original"}`)
	return post
}

func TestGetPublicPostSEO(t *testing.T) {
	getView := func(t *testing.T, store *mockdb.MockStore, server *Server) publicPostView {
		t.Helper()
		recorder := serveSettingsGET(t, server, "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.NotContains(t, recorder.Body.String(), "Working SEO", "the working SEO waits for Update")
		var view publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
		require.Nil(t, view.Post.SEO)
		return view
	}

	t.Run("SocialImageVariant", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		upload := server.config.UploadPath
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(seoPublishedPost("12"), nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{12, 5}).Times(1).Return([]db.Medium{
			{ID: 5, MimeType: "image/jpeg", MediaPath: filepath.Join(upload, "featured.jpg"), Width: 800, Height: 600},
			{ID: 12, MimeType: "image/png", MediaPath: filepath.Join(upload, "share.png"), Width: 2400, Height: 1260, Alt: "Two documents",
				Variants: json.RawMessage(fmt.Sprintf(`{"social": {"path": %q, "width": 1200, "height": 630}}`, filepath.Join(upload, "_variants", "share.png", "social.png")))},
		}, nil)

		view := getView(t, store, server)
		require.Equal(t, "Published SEO title", view.SEO.Title)
		require.Equal(t, "Published SEO description", view.SEO.Description)
		require.True(t, view.SEO.Noindex)
		require.Equal(t, "https://example.com/original", view.SEO.CanonicalURL)
		require.Equal(t, &publicSocialImage{URL: "/uploads/media/_variants/share.png/social.png", Width: 1200, Height: 630, Alt: "Two documents"}, view.SEO.Image)
	})

	t.Run("FallsBackToFeaturedImage", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(seoPublishedPost("null"), nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil)
		// No social crop (too small): the original.
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{5}).Return([]db.Medium{
			{ID: 5, MimeType: "image/jpeg", MediaPath: filepath.Join(server.config.UploadPath, "featured.jpg"), Width: 300, Height: 200, Alt: "Ignored", Decorative: true},
		}, nil)
		view := getView(t, store, server)
		require.Equal(t, &publicSocialImage{URL: "/uploads/media/featured.jpg", Width: 300, Height: 200}, view.SEO.Image, "a decorative image has no alt")
	})

	t.Run("DeletedSocialImage", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(seoPublishedPost("12"), nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{12, 5}).Return([]db.Medium{
			{ID: 5, MimeType: "image/jpeg", MediaPath: filepath.Join(server.config.UploadPath, "featured.jpg")},
		}, nil)
		view := getView(t, store, server)
		require.Equal(t, "/uploads/media/featured.jpg", view.SEO.Image.URL)
	})

	t.Run("NoImage", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		post := seoPublishedPost("null")
		post.PublishedSettings = publishedSettings(`{"title": "T", "description": "", "featured_image": null, "term_ids": []}`)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(post, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Times(0)
		view := getView(t, store, newTestServer(t, store))
		require.Equal(t, publicPostSEO{}, view.SEO, "a pre-#357 snapshot has the defaults")
	})

	t.Run("LegacyFeaturedURL", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		post := seoPublishedPost("null")
		post.PublishedSettings = publishedSettings(`{"title": "T", "description": "", "featured_image": {"id": null, "url": "/uploads/media/old.jpg"}, "term_ids": []}`)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(post, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil)
		view := getView(t, store, newTestServer(t, store))
		require.Equal(t, &publicSocialImage{URL: "/uploads/media/old.jpg"}, view.SEO.Image)
	})

	t.Run("MediaError", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(seoPublishedPost("12"), nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Return(nil, fmt.Errorf("db down"))
		require.Equal(t, http.StatusInternalServerError, serveSettingsGET(t, newTestServer(t, store), "/public/posts/7").Code)
	})
}

// The sitemap reads /public/posts: a post hidden from search engines is flagged
// by its published noindex, so the sitemap leaves it out. The working one waits.
func TestListPublicPostsNoindex(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	store.EXPECT().GetPostType(gomock.Any(), "post").Return(db.PostType{Name: "post", Public: true, IsActive: true}, nil)
	store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(3), nil)
	store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Return([]db.ListPostsRow{
		{ID: 1, Title: "Hidden", PostStatus: "published", PublishedSettings: seoPublishedPost("null").PublishedSettings},
		{ID: 2, Title: "Indexed", PostStatus: "published", PublishedSettings: publishedSettings(publishedSettingsJSON)},
		{ID: 3, Title: "No snapshot", PostStatus: "published"},
	}, nil)

	recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts?type=post&limit=100")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var resp struct {
		Posts []map[string]interface{} `json:"posts"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
	require.Len(t, resp.Posts, 3)
	require.Equal(t, true, resp.Posts[0]["noindex"])
	require.Equal(t, false, resp.Posts[1]["noindex"])
	require.Equal(t, false, resp.Posts[2]["noindex"])
	require.NotContains(t, resp.Posts[0], "seo", "no working SEO in the public list")
}

func TestRestorePostVersionSettingsSEO(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	stubRoleLookup(store, publishEditor)
	store.EXPECT().GetPostVersion(gomock.Any(), db.GetPostVersionParams{PostID: 7, VersionNo: 2}).
		Return(db.GetPostVersionRow{ID: 11, VersionNo: 2, Settings: seoPublishedPost("12").PublishedSettings}, nil)
	store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.RestorePostSettingsTxParams) (db.Post, error) {
			s := arg.Settings
			require.Equal(t, "Published SEO title", s.SEOTitle)
			require.Equal(t, "Published SEO description", s.SEODescription)
			require.Equal(t, int64(12), *s.SocialImageID)
			require.True(t, s.Noindex)
			require.Equal(t, "https://example.com/original", s.CanonicalURL)
			return db.Post{ID: 7, SeoTitle: s.SEOTitle, Noindex: s.Noindex}, nil
		})
	recorder := settingsRequest(t, newTestServer(t, store), http.MethodPost, "/api/v1/posts/7/versions/2/restore-settings", publishEditor)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"seo_title":"Published SEO title"`)
}

// The excerpt is optional (#357): the old 10-character minimum is gone.
func TestPostExcerptOptional(t *testing.T) {
	t.Run("CreateWithoutExcerpt", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Return(false, nil)
		store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, nil)
		store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ any, arg db.CreatePostTxParams) (db.CreatePostTxResult, error) {
				require.Equal(t, "", arg.Description)
				return db.CreatePostTxResult{Post: db.Post{ID: 9, Title: arg.Title}}, nil
			})
		body := `{"title": "No excerpt", "url": "https://example.com/post/no-excerpt", "author_ids": [1]}`
		recorder := seoRequest(t, newTestServer(t, store), http.MethodPost, "/api/v1/posts", body, publishEditor)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	})

	t.Run("CreateShortExcerpt", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Return(false, nil)
		store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, nil)
		store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Return(db.CreatePostTxResult{Post: db.Post{ID: 9}}, nil)
		body := `{"title": "Short", "description": "Hi", "url": "https://example.com/post/short", "author_ids": [1]}`
		require.Equal(t, http.StatusCreated, seoRequest(t, newTestServer(t, store), http.MethodPost, "/api/v1/posts", body, publishEditor).Code)
	})

	t.Run("CreateTooLong", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		body := fmt.Sprintf(`{"title": "Long", "description": %q, "url": "https://example.com/post/long", "author_ids": [1]}`, strings.Repeat("a", 501))
		require.Equal(t, http.StatusBadRequest, seoRequest(t, newTestServer(t, store), http.MethodPost, "/api/v1/posts", body, publishEditor).Code)
	})

	for _, tc := range []struct {
		name, body, want string
	}{
		{"UpdateClears", `{"description": ""}`, ""},
		{"UpdateKeeps", `{"title": "New title"}`, "Old excerpt"},
		{"UpdateShort", `{"description": " Hi "}`, "Hi"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubRoleLookup(store, publishEditor)
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, Title: "Old title", Description: "Old excerpt", PostStatus: "draft"}, nil)
			store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdatePostParams) (db.Post, error) {
					require.Equal(t, tc.want, arg.Description)
					return db.Post{ID: 7, Description: arg.Description}, nil
				})
			recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, "/api/v1/posts/7", tc.body, publishEditor)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		})
	}
}

func TestStoredFocal(t *testing.T) {
	// A point near the displayed top-left corner, through each orientation, lands
	// where applyOrientation takes that pixel from.
	src := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for orientation := 1; orientation <= 8; orientation++ {
		marked := image.NewRGBA(src.Bounds())
		out := applyOrientation(marked, orientation)
		dw, dh := out.Bounds().Dx(), out.Bounds().Dy()
		fx, fy := 0.1, 0.2
		sx, sy := storedFocal(orientation, fx, fy)
		// Mark the stored pixel, orient, and find it on the displayed image.
		marked.SetRGBA(int(sx*40), int(sy*20), color.RGBA{255, 0, 0, 255})
		out = applyOrientation(marked, orientation)
		x, y := int(fx*float64(dw)), int(fy*float64(dh))
		found := false
		for dy := -1; dy <= 1 && !found; dy++ {
			for dx := -1; dx <= 1 && !found; dx++ {
				if r, _, _, _ := out.At(x+dx, y+dy).RGBA(); r > 0 {
					found = true
				}
			}
		}
		require.True(t, found, "orientation %d", orientation)
	}
}

func TestSocialCrop(t *testing.T) {
	for _, tc := range []struct {
		name              string
		w, h, orientation int
		focal             *FocalPoint
		wantCrop          image.Rectangle
		wantW, wantH      int
	}{
		{"WideCentered", 4000, 1000, 1, nil, image.Rect(1048, 0, 2953, 1000), 1200, 630},
		{"WideFocalLeft", 4000, 1000, 1, &FocalPoint{X: 0, Y: 0.5}, image.Rect(0, 0, 1905, 1000), 1200, 630},
		{"TallFocalBottom", 1000, 3000, 1, &FocalPoint{X: 0.5, Y: 1}, image.Rect(0, 2475, 1000, 3000), 1000, 525},
		{"TallFocalTop", 2400, 3000, 1, &FocalPoint{X: 0.5, Y: 0}, image.Rect(0, 0, 2400, 1260), 1200, 630},
		{"ExactShape", 1200, 630, 1, nil, image.Rect(0, 0, 1200, 630), 1200, 630},
		// Rotated 90 degrees: stored 1000 wide x 3000 tall shows as 3000 x 1000, so
		// the crop is 1905 x 1000 as displayed, 1000 x 1905 stored.
		{"Rotated", 1000, 3000, 6, nil, image.Rect(0, 548, 1000, 2453), 630, 1200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			crop, w, h := socialCrop(image.Rect(0, 0, tc.w, tc.h), tc.orientation, tc.focal)
			require.Equal(t, tc.wantCrop, crop)
			require.Equal(t, [2]int{tc.wantW, tc.wantH}, [2]int{w, h})
		})
	}
}

// halvesJPEG is an image whose top half is red and bottom half blue.
func halvesJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		c := color.RGBA{220, 20, 20, 255}
		if y >= h/2 {
			c = color.RGBA{20, 20, 220, 255}
		}
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}))
	return buf.Bytes()
}

func socialCenter(t *testing.T, mediaPath string) (r, b uint32) {
	t.Helper()
	f, err := os.Open(variantFile(mediaPath, "social.jpg"))
	require.NoError(t, err)
	defer f.Close()
	img, err := jpeg.Decode(f)
	require.NoError(t, err)
	b0 := img.Bounds()
	r, _, b, _ = img.At(b0.Dx()/2, b0.Dy()/2).RGBA()
	return r >> 8, b >> 8
}

func TestSocialVariantFollowsFocalPoint(t *testing.T) {
	uploadPath, mediaPath := writeUpload(t, "tall.jpg", halvesJPEG(t, 800, 1600))

	staged, err := stageImageVariants(uploadPath, mediaPath, &FocalPoint{X: 0.5, Y: 0.05})
	require.NoError(t, err)
	social := staged.variants["social"]
	require.Equal(t, int32(800), social.Width)
	require.Equal(t, int32(420), social.Height)
	require.NoError(t, staged.commit())
	r, b := socialCenter(t, mediaPath)
	require.Greater(t, r, b, "focal point at the top: the red half")

	staged, err = stageImageVariants(uploadPath, mediaPath, &FocalPoint{X: 0.5, Y: 0.95})
	require.NoError(t, err)
	require.NoError(t, staged.commit())
	r, b = socialCenter(t, mediaPath)
	require.Greater(t, b, r, "focal point at the bottom: the blue half")
}

// Setting the focal point regenerates the variants, so the social crop moves.
func TestUpdateMediaFocalPointRegeneratesSocialCrop(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	stubRoleLookup(store, publishEditor)
	server := newTestServer(t, store)
	mediaPath := filepath.Join(server.config.UploadPath, "tall.jpg")
	require.NoError(t, os.MkdirAll(server.config.UploadPath, 0755))
	require.NoError(t, os.WriteFile(mediaPath, halvesJPEG(t, 800, 1600), 0644))

	changedAt := time.Now()
	row := db.Medium{ID: 4, MimeType: "image/jpeg", MediaPath: mediaPath, Width: 800, Height: 1600, ChangedAt: changedAt,
		Variants: json.RawMessage(`{"thumb": {"path": "x", "width": 160, "height": 320}}`),
		FocalX:   sql.NullFloat64{Float64: 0.5, Valid: true},
		FocalY:   sql.NullFloat64{Float64: 0.95, Valid: true}}
	store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Return(row, nil)
	store.EXPECT().SetMediaVariantsTx(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.SetMediaVariantsTxParams) (db.Medium, error) {
			require.Equal(t, int64(4), arg.ID)
			require.Equal(t, mediaPath, arg.MediaPath)
			require.True(t, changedAt.Equal(arg.ChangedAt), "conditional on the row just written")
			v := parseMediaVariants(arg.Variants)
			require.Contains(t, v, "social")
			require.NoError(t, arg.CommitFiles())
			updated := row
			updated.Variants = arg.Variants
			return updated, nil
		})

	recorder := seoRequest(t, server, http.MethodPut, "/api/v1/media/4", `{"focal_point": {"x": 0.5, "y": 0.95}}`, publishEditor)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), "social.jpg")
	r, b := socialCenter(t, mediaPath)
	require.Greater(t, b, r)
}

// A focal point on an image without variants, or a lost race, changes nothing.
func TestUpdateMediaFocalPointSkipsRegeneration(t *testing.T) {
	t.Run("NoVariants", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Return(db.Medium{ID: 4, MimeType: "image/png", Variants: json.RawMessage(`{}`)}, nil)
		store.EXPECT().SetMediaVariantsTx(gomock.Any(), gomock.Any()).Times(0)
		recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, "/api/v1/media/4", `{"focal_point": null}`, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code)
	})

	t.Run("ReplacedMeanwhile", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, publishEditor)
		server := newTestServer(t, store)
		mediaPath := filepath.Join(server.config.UploadPath, "x.jpg")
		require.NoError(t, os.MkdirAll(server.config.UploadPath, 0755))
		require.NoError(t, os.WriteFile(mediaPath, halvesJPEG(t, 800, 400), 0644))
		store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Return(db.Medium{ID: 4, MimeType: "image/jpeg", MediaPath: mediaPath,
			Variants: json.RawMessage(`{"thumb": {"path": "x"}}`)}, nil)
		store.EXPECT().SetMediaVariantsTx(gomock.Any(), gomock.Any()).Return(db.Medium{}, db.ErrMediaChanged)
		recorder := seoRequest(t, server, http.MethodPut, "/api/v1/media/4", `{"focal_point": {"x": 0.1, "y": 0.1}}`, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code)
		_, err := os.Stat(variantFile(mediaPath, "social.jpg"))
		require.True(t, os.IsNotExist(err), "nothing committed")
	})
}

func TestResizedOnly(t *testing.T) {
	variants := MediaVariants{"thumb": {Width: 320}, "social": {Width: 1200}}
	require.Equal(t, MediaVariants{"thumb": {Width: 320}}, resizedOnly(variants))
	require.Len(t, variants, 2, "input not mutated")
	plain := MediaVariants{"thumb": {Width: 320}}
	require.Equal(t, plain, resizedOnly(plain))
}
