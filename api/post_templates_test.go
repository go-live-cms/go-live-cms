package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func templateRequest(t *testing.T, server *Server, caller *db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, path, reader)
	require.NoError(t, err)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if caller != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	return raw
}

func TestTemplatePostSlugAndURL(t *testing.T) {
	require.Equal(t, "weekly-update", templateSlugBase("Weekly update"))
	require.Equal(t, "post", templateSlugBase("!!!"), "no usable character: normalizePostSlug's fallback")
	long := templateSlugBase(strings.Repeat("a", 300))
	require.Len(t, long, postSlugMax-len("-99"), "room for the -2 … -99 suffix")
	require.Equal(t, "/page/weekly-update", templatePostURL("page", "weekly-update"))
}

func TestPostTemplatesAPI(t *testing.T) {
	v := loadDuplicateVectors(t)
	admin := db.User{ID: 100, Username: "admin1", Role: RoleAdmin}
	editor := db.User{ID: 101, Username: "editor1", Role: RoleEditor}
	contributor := db.User{ID: 103, Username: "contrib1", Role: RoleContributor}
	reader := db.User{ID: 104, Username: "reader1", Role: "user"}

	source := db.Post{ID: 77, Title: "My post", Slug: "my-post", PostType: "page", PostStatus: "published", UserID: contributor.ID, BlockDoc: v.Source}
	row := db.ListPostTemplatesRow{
		ID: 900, PostType: "page", Name: "Weekly update",
		FeaturedMediaID: sql.NullInt64{Int64: 42, Valid: true},
		CreatedBy:       sql.NullInt64{Int64: editor.ID, Valid: true},
		CreatedByName:   "Ed Itor",
		Terms:           json.RawMessage(`[{"id":7,"name":"News"}]`),
	}
	template := db.PostTemplate{ID: 900, PostType: "page", Name: "Weekly update", BlockDoc: v.Source}

	run := func(t *testing.T, caller *db.User, method, path string, body any, stubs func(*mockdb.MockStore), adjust ...func(*Server)) (*httptest.ResponseRecorder, *Server) {
		t.Helper()
		store := mockdb.NewMockStore(gomock.NewController(t))
		if stubs != nil {
			stubs(store)
		}
		if caller != nil {
			stubRoleLookup(store, *caller)
		}
		server := newTestServer(t, store)
		for _, fn := range adjust {
			fn(server)
		}
		return templateRequest(t, server, caller, method, path, body), server
	}
	rowByID := func(store *mockdb.MockStore) {
		store.EXPECT().ListPostTemplates(gomock.Any(), db.ListPostTemplatesParams{ID: sql.NullInt64{Int64: 900, Valid: true}}).Return([]db.ListPostTemplatesRow{row}, nil)
	}
	decodeTemplate := func(t *testing.T, recorder *httptest.ResponseRecorder) PostTemplateResponse {
		t.Helper()
		var body struct {
			Template PostTemplateResponse `json:"template"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body.Template
	}

	t.Run("list", func(t *testing.T) {
		t.Run("a contributor lists a type's templates", func(t *testing.T) {
			recorder, _ := run(t, &contributor, http.MethodGet, "/api/v1/post-templates?type=page", nil, func(store *mockdb.MockStore) {
				store.EXPECT().ListPostTemplates(gomock.Any(), db.ListPostTemplatesParams{PostType: sql.NullString{String: "page", Valid: true}}).
					Return([]db.ListPostTemplatesRow{row}, nil)
			})
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			var body struct {
				Templates []PostTemplateResponse `json:"templates"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Len(t, body.Templates, 1)
			got := body.Templates[0]
			require.Equal(t, "Weekly update", got.Name)
			require.Equal(t, []PostTemplateTerm{{ID: 7, Name: "News"}}, got.Terms)
			require.Equal(t, int64(42), *got.FeaturedImageID)
			require.Equal(t, editor.ID, *got.CreatedByID)
			require.NotContains(t, recorder.Body.String(), "block_doc", "the list carries no content")
		})
		t.Run("every type, and empty terms", func(t *testing.T) {
			bare := db.ListPostTemplatesRow{ID: 1, PostType: "post", Name: "Bare"}
			recorder, _ := run(t, &editor, http.MethodGet, "/api/v1/post-templates", nil, func(store *mockdb.MockStore) {
				store.EXPECT().ListPostTemplates(gomock.Any(), db.ListPostTemplatesParams{}).Return([]db.ListPostTemplatesRow{bare}, nil)
			})
			require.Equal(t, http.StatusOK, recorder.Code)
			require.Contains(t, recorder.Body.String(), `"terms":[]`)
			require.Contains(t, recorder.Body.String(), `"featured_image_id":null`)
			require.Contains(t, recorder.Body.String(), `"created_by_id":null`)
		})
		t.Run("not a content role", func(t *testing.T) {
			recorder, _ := run(t, &reader, http.MethodGet, "/api/v1/post-templates", nil, nil)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
		t.Run("no token", func(t *testing.T) {
			recorder, _ := run(t, nil, http.MethodGet, "/api/v1/post-templates", nil, nil)
			require.Equal(t, http.StatusUnauthorized, recorder.Code)
		})
		t.Run("a type that can't be one", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodGet, "/api/v1/post-templates?type="+strings.Repeat("x", 51), nil, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
		t.Run("the query fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodGet, "/api/v1/post-templates", nil, func(store *mockdb.MockStore) {
				store.EXPECT().ListPostTemplates(gomock.Any(), gomock.Any()).Return(nil, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
	})

	t.Run("create", func(t *testing.T) {
		body := gin.H{"post_id": 77, "name": "  Weekly update ", "with_settings": true}
		var got db.CreatePostTemplateTxParams
		capture := func(store *mockdb.MockStore) {
			store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, arg db.CreatePostTemplateTxParams) (db.PostTemplate, error) {
					got = arg
					return db.PostTemplate{ID: 900}, nil
				})
		}
		withPost := func(post db.Post) func(*mockdb.MockStore) {
			return func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(post, nil) // before and after the flush
			}
		}

		t.Run("an editor saves a post as a template", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(source)(store)
				capture(store)
				rowByID(store)
			})
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
			require.Equal(t, db.CreatePostTemplateTxParams{
				SourcePostID: 77, PostType: "page", Name: "Weekly update", BlockDoc: got.BlockDoc, WithSettings: true, CreatedBy: editor.ID,
			}, got, "trimmed name, the post's type, the caller")
			// The same content (prepareForStore changes nothing in a valid doc).
			require.JSONEq(t, string(v.Source), string(got.BlockDoc))
			require.Equal(t, "Weekly update", decodeTemplate(t, recorder).Name)
		})
		t.Run("an admin may too, without the settings", func(t *testing.T) {
			recorder, _ := run(t, &admin, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": 77, "name": "Plain"}, func(store *mockdb.MockStore) {
				withPost(source)(store)
				capture(store)
				rowByID(store)
			})
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
			require.False(t, got.WithSettings)
		})
		t.Run("a contributor may not", func(t *testing.T) {
			recorder, _ := run(t, &contributor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).Times(0)
			})
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
		t.Run("the content is sanitized like a post's", func(t *testing.T) {
			post := source
			post.BlockDoc = mustJSON(t, paragraphWithText("click me", linkMark("javascript:alert(1)"), nil))
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(post)(store)
				capture(store)
				rowByID(store)
			})
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
			require.Contains(t, string(got.BlockDoc), "click me")
			require.NotContains(t, string(got.BlockDoc), "javascript:")
		})
		t.Run("content prepareForStore refuses isn't saved", func(t *testing.T) {
			post := source
			post.BlockDoc = json.RawMessage(`{"doc_version":1,"blocks_order":["gone"],"blocks":{}}`)
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(post)(store)
				store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).Times(0)
			})
			require.Equal(t, http.StatusBadRequest, recorder.Code)
			require.Contains(t, recorder.Body.String(), "not found in blocks")
		})
		t.Run("a theme block with a value its spec refuses isn't saved (#376)", func(t *testing.T) {
			post := source
			post.BlockDoc = mustJSON(t, themeBlockDoc(map[string]interface{}{"blk-alert-00001": map[string]interface{}{
				"id": "blk-alert-00001", "type": "theme:example/alert", "version": 1, "attrs": map[string]interface{}{"variant": "<script>"},
			}}))
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(post)(store)
				store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).Times(0)
			}, func(server *Server) { server.themeBlocks = loadRepoThemeBlocks(t) })
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), "variant")
		})
		t.Run("a stored block_doc that isn't a document", func(t *testing.T) {
			post := source
			post.BlockDoc = json.RawMessage(`[]`)
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(post)(store)
			})
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
		t.Run("a post that never had blocks gives an empty template", func(t *testing.T) {
			post := source
			post.BlockDoc = json.RawMessage(`{}`)
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(post)(store)
				capture(store)
				rowByID(store)
			})
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
			require.JSONEq(t, `{"doc_version":1,"blocks_order":[],"blocks":{}}`, string(got.BlockDoc))
		})
		for _, bad := range []gin.H{
			{"post_id": 77, "name": "ab"},
			{"post_id": 77, "name": "   "},
			{"post_id": 77, "name": "two\nlines"},
			{"post_id": 77, "name": strings.Repeat("x", 121)},
			{"name": "Weekly update"},
			{"post_id": 77, "name": "Weekly update", "extra": true},
		} {
			t.Run(fmt.Sprintf("bad request %v", bad), func(t *testing.T) {
				recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", bad, nil)
				require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			})
		}
		t.Run("missing post", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrNoRows)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("the post lookup fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("the post went missing after the flush", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				gomock.InOrder(
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(source, nil),
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrNoRows),
				)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("the read after the flush fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				gomock.InOrder(
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(source, nil),
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrConnDone),
				)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("a trashed post", func(t *testing.T) {
			trashed := source
			trashed.PostStatus = postStatusTrash
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(trashed, nil)
			})
			require.Equal(t, http.StatusConflict, recorder.Code)
			require.Contains(t, recorder.Body.String(), "post_trashed")
		})
		t.Run("the name is taken for this type", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(source)(store)
				store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).
					Return(db.PostTemplate{}, errors.New(`pq: duplicate key value violates unique constraint "post_templates_type_name_key"`))
			})
			require.Equal(t, http.StatusConflict, recorder.Code)
			require.Contains(t, recorder.Body.String(), codeTemplateNameTaken)
		})
		t.Run("the transaction fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(source)(store)
				store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).Return(db.PostTemplate{}, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("reading it back fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates", body, func(store *mockdb.MockStore) {
				withPost(source)(store)
				capture(store)
				store.EXPECT().ListPostTemplates(gomock.Any(), gomock.Any()).Return(nil, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
	})

	t.Run("a failed collab flush saves nothing", func(t *testing.T) {
		collab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		t.Cleanup(collab.Close)
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, editor)
		store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(1).Return(source, nil)
		store.EXPECT().CreatePostTemplateTx(gomock.Any(), gomock.Any()).Times(0)
		server := newCollabTestServer(t, store, collab.URL)
		recorder := templateRequest(t, server, &editor, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": 77, "name": "Weekly update"})
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
		require.Contains(t, recorder.Body.String(), "no template was saved")
	})

	t.Run("rename", func(t *testing.T) {
		t.Run("an editor renames", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": " Monthly update "}, func(store *mockdb.MockStore) {
				store.EXPECT().RenamePostTemplate(gomock.Any(), db.RenamePostTemplateParams{ID: 900, Name: "Monthly update"}).Return(template, nil)
				rowByID(store)
			})
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		})
		t.Run("a contributor may not", func(t *testing.T) {
			recorder, _ := run(t, &contributor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "Monthly update"}, nil)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
		t.Run("missing", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "Monthly update"}, func(store *mockdb.MockStore) {
				store.EXPECT().RenamePostTemplate(gomock.Any(), gomock.Any()).Return(db.PostTemplate{}, sql.ErrNoRows)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("missing when read back", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "Monthly update"}, func(store *mockdb.MockStore) {
				store.EXPECT().RenamePostTemplate(gomock.Any(), gomock.Any()).Return(template, nil)
				store.EXPECT().ListPostTemplates(gomock.Any(), gomock.Any()).Return([]db.ListPostTemplatesRow{}, nil)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("the name is taken", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "Monthly update"}, func(store *mockdb.MockStore) {
				store.EXPECT().RenamePostTemplate(gomock.Any(), gomock.Any()).
					Return(db.PostTemplate{}, errors.New(`pq: duplicate key value violates unique constraint "post_templates_type_name_key"`))
			})
			require.Equal(t, http.StatusConflict, recorder.Code)
		})
		t.Run("the update fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "Monthly update"}, func(store *mockdb.MockStore) {
				store.EXPECT().RenamePostTemplate(gomock.Any(), gomock.Any()).Return(db.PostTemplate{}, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("bad id and bad name", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPut, "/api/v1/post-templates/abc", gin.H{"name": "Monthly update"}, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
			recorder, _ = run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{"name": "x"}, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
			recorder, _ = run(t, &editor, http.MethodPut, "/api/v1/post-templates/900", gin.H{}, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	})

	t.Run("delete", func(t *testing.T) {
		t.Run("an editor deletes", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodDelete, "/api/v1/post-templates/900", nil, func(store *mockdb.MockStore) {
				store.EXPECT().DeletePostTemplate(gomock.Any(), int64(900)).Return(int64(1), nil)
			})
			require.Equal(t, http.StatusNoContent, recorder.Code)
		})
		t.Run("a contributor may not", func(t *testing.T) {
			recorder, _ := run(t, &contributor, http.MethodDelete, "/api/v1/post-templates/900", nil, nil)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
		t.Run("missing", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodDelete, "/api/v1/post-templates/900", nil, func(store *mockdb.MockStore) {
				store.EXPECT().DeletePostTemplate(gomock.Any(), int64(900)).Return(int64(0), nil)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodDelete, "/api/v1/post-templates/900", nil, func(store *mockdb.MockStore) {
				store.EXPECT().DeletePostTemplate(gomock.Any(), int64(900)).Return(int64(0), sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("bad id", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodDelete, "/api/v1/post-templates/0", nil, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	})

	t.Run("new post from a template", func(t *testing.T) {
		var got db.CreatePostFromTemplateTxParams
		capture := func(store *mockdb.MockStore) {
			store.EXPECT().CreatePostFromTemplateTx(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, arg db.CreatePostFromTemplateTxParams) (db.Post, error) {
					got = arg
					return db.Post{ID: 501, Title: arg.Title, PostType: arg.PostType, PostStatus: arg.PostStatus, Slug: arg.Slug, UserID: arg.UserID, BlockDoc: arg.BlockDoc}, nil
				})
		}
		fresh := func(store *mockdb.MockStore) {
			store.EXPECT().GetPostTemplate(gomock.Any(), int64(900)).Return(template, nil)
			store.EXPECT().CheckSlugExists(gomock.Any(), db.CheckSlugExistsParams{Slug: "weekly-update"}).Return(false, nil)
			store.EXPECT().CheckURLExists(gomock.Any(), "/page/weekly-update").Return(false, nil)
		}

		t.Run("a contributor starts a draft of their own with fresh block ids", func(t *testing.T) {
			recorder, server := run(t, &contributor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				fresh(store)
				capture(store)
			})
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
			require.Equal(t, int64(900), got.TemplateID)
			require.Equal(t, "Weekly update", got.Title)
			require.Equal(t, "page", got.PostType)
			require.Equal(t, "draft", got.PostStatus)
			require.Equal(t, contributor.ID, got.UserID, "the caller owns it")
			require.Equal(t, contributor.Username, got.Username)
			require.False(t, got.PostParent.Valid)
			require.Equal(t, "weekly-update", got.Slug)
			require.Equal(t, "/page/weekly-update", got.Url)
			requireRegeneratedFrom(t, v.Source, got.BlockDoc)
			requireContentMediaIDs(t, []int64{42}, got.ContentMedia)
			stored := server.config.UploadPath + "/x.jpg"
			require.Equal(t, publicMediaPath(server.config.UploadPath, stored), got.PublicMediaPath(stored), "the URL /uploads serves")
			require.NotEqual(t, stored, got.PublicMediaPath(stored))
			require.Equal(t, []string{fmt.Sprintf("created post:%d", 501)}, activityOf(t, server).verbs())

			var body struct {
				Post PostResponse `json:"post"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, int64(501), body.Post.ID)
		})
		t.Run("two posts from one template share no id", func(t *testing.T) {
			docs := []json.RawMessage{}
			for i := 0; i < 2; i++ {
				recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
					fresh(store)
					capture(store)
				})
				require.Equal(t, http.StatusCreated, recorder.Code)
				docs = append(docs, got.BlockDoc)
			}
			for _, id := range requireRegeneratedFrom(t, v.Source, docs[0]) {
				require.NotContains(t, string(docs[1]), id)
			}
		})
		t.Run("not a content role", func(t *testing.T) {
			recorder, _ := run(t, &reader, http.MethodPost, "/api/v1/post-templates/900/posts", nil, nil)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
		t.Run("missing template", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				store.EXPECT().GetPostTemplate(gomock.Any(), int64(900)).Return(db.PostTemplate{}, sql.ErrNoRows)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("the lookup fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				store.EXPECT().GetPostTemplate(gomock.Any(), int64(900)).Return(db.PostTemplate{}, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("deleted meanwhile", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				fresh(store)
				store.EXPECT().CreatePostFromTemplateTx(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
			})
			require.Equal(t, http.StatusNotFound, recorder.Code)
		})
		t.Run("a concurrent writer took the slug", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				fresh(store)
				store.EXPECT().CreatePostFromTemplateTx(gomock.Any(), gomock.Any()).
					Return(db.Post{}, errors.New(`pq: duplicate key value violates unique constraint "idx_posts_slug"`))
			})
			require.Equal(t, http.StatusConflict, recorder.Code)
		})
		t.Run("the transaction fails", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				fresh(store)
				store.EXPECT().CreatePostFromTemplateTx(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrConnDone)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("content today's checks refuse makes no post", func(t *testing.T) {
			stale := template
			stale.BlockDoc = mustJSON(t, themeBlockDoc(map[string]interface{}{"blk-alert-00001": map[string]interface{}{
				"id": "blk-alert-00001", "type": "theme:example/alert", "version": 1, "attrs": map[string]interface{}{"variant": "<script>"},
			}}))
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				store.EXPECT().GetPostTemplate(gomock.Any(), int64(900)).Return(stale, nil)
				store.EXPECT().CreatePostFromTemplateTx(gomock.Any(), gomock.Any()).Times(0)
			}, func(server *Server) { server.themeBlocks = loadRepoThemeBlocks(t) })
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), "no longer valid")
		})
		t.Run("a stored block_doc that isn't a document", func(t *testing.T) {
			broken := template
			broken.BlockDoc = json.RawMessage(`[]`)
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/900/posts", nil, func(store *mockdb.MockStore) {
				store.EXPECT().GetPostTemplate(gomock.Any(), int64(900)).Return(broken, nil)
			})
			require.Equal(t, http.StatusInternalServerError, recorder.Code)
		})
		t.Run("bad id", func(t *testing.T) {
			recorder, _ := run(t, &editor, http.MethodPost, "/api/v1/post-templates/x/posts", nil, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	})
}
