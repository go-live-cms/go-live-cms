package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-playground/validator/v10"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Input validation and body limits (#139).

func validationTestUser(role string) db.User {
	return db.User{ID: 4242, Username: "alice", FullName: "Alice", Email: "alice@example.com", Role: role}
}

// errorBody is the JSON error shape every 4xx shares.
type errorBody struct {
	Error     string            `json:"error"`
	Fields    map[string]string `json:"fields"`
	RequestID string            `json:"request_id"`
}

func decodeErrorBody(t *testing.T, recorder *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body), recorder.Body.String())
	require.NotEmpty(t, body.Error)
	require.NotEmpty(t, body.RequestID)
	// Never leak Go struct names, types or validator internals.
	for _, leak := range []string{"Key: '", "Error:Field", "Go struct", "json: ", "strconv."} {
		require.NotContains(t, body.Error, leak)
	}
	return body
}

// sendAs sends a request as user (nil: anonymous) through the full router.
func sendAs(t *testing.T, server *Server, user *db.User, method, url string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if user != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// TestRejectedWriteInput sends invalid bodies to each write endpoint as a
// caller allowed to use it. Every case must fail with 400 before the
// handler touches the store (the mock fails on any call but the caller
// lookup).
func TestRejectedWriteInput(t *testing.T) {
	longString := func(n int) string { return strings.Repeat("a", n) }

	testCases := []struct {
		name   string
		role   string
		method string
		url    string
		body   string
		field  string // expected key in "fields"; "" when not field-specific
	}{
		// Posts
		{"post javascript url", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"javascript:alert(1)","author_ids":[1]}`, "url"},
		{"post relative url", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"/post/hello","author_ids":[1]}`, "url"},
		{"post unknown field", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":[1],"user_id":7}`, "user_id"},
		{"post title too long", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"` + longString(256) + `","description":"A long enough description","url":"https://x.test/p","author_ids":[1]}`, "title"},
		{"post bad status enum", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":[1],"post_status":"live"}`, "post_status"},
		{"post path in post type", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":[1],"post_type":"../etc"}`, "post_type"},
		{"post too many authors", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]}`, "author_ids"},
		{"post wrong type", "editor", http.MethodPost, "/api/v1/posts",
			`{"title":"Hello","description":"A long enough description","url":"https://x.test/p","author_ids":"1"}`, "author_ids"},
		{"post update javascript url", "editor", http.MethodPut, "/api/v1/posts/1",
			`{"url":"JavaScript:alert(1)"}`, "url"},
		{"post update unknown field", "editor", http.MethodPut, "/api/v1/posts/1",
			`{"published_block_doc":{}}`, "published_block_doc"},
		{"post trailing data", "editor", http.MethodPut, "/api/v1/posts/1",
			`{"title":"Hello"}{"title":"again"}`, ""},
		{"post malformed json", "editor", http.MethodPut, "/api/v1/posts/1",
			`{"title":`, ""},
		{"post empty body", "editor", http.MethodPut, "/api/v1/posts/1", ``, ""},
		// Meta, featured image, media links
		{"meta key with space", "editor", http.MethodPost, "/api/v1/posts/1/meta",
			`{"meta_key":"a b","meta_value":"x"}`, "meta_key"},
		{"meta value too big", "editor", http.MethodPost, "/api/v1/posts/1/meta",
			`{"meta_key":"k","meta_value":"` + longString(65537) + `"}`, "meta_value"},
		{"featured image missing media", "editor", http.MethodPost, "/api/v1/posts/1/featured-image",
			`{"media_path":"/uploads/x.png"}`, "media_id"},
		{"post media negative order", "editor", http.MethodPost, "/api/v1/posts/1/media",
			`{"media_id":3,"order":-1}`, "order"},
		// Blocks
		{"publish label too long", "editor", http.MethodPost, "/api/v1/posts/1/publish",
			`{"label":"` + longString(256) + `"}`, "label"},
		{"publish unknown field", "editor", http.MethodPost, "/api/v1/posts/1/publish",
			`{"labell":"v1"}`, "labell"},
		// Users
		{"user username not alphanumeric", "admin", http.MethodPost, "/api/v1/users",
			`{"username":"john.doe","email":"j@example.com","full_name":"John","password":"secret1","role":"editor"}`, "username"},
		{"user password over 72 bytes", "admin", http.MethodPost, "/api/v1/users",
			`{"username":"johndoe","email":"j@example.com","full_name":"John","password":"` + strings.Repeat("é", 37) + `","role":"editor"}`, "password"},
		{"user bad role", "admin", http.MethodPost, "/api/v1/users",
			`{"username":"johndoe","email":"j@example.com","full_name":"John","password":"secret1","role":"owner"}`, "role"},
		{"user bad email", "admin", http.MethodPost, "/api/v1/users",
			`{"username":"johndoe","email":"nope","full_name":"John","password":"secret1","role":"editor"}`, "email"},
		{"user server-owned field", "admin", http.MethodPost, "/api/v1/users",
			`{"username":"johndoe","email":"j@example.com","full_name":"John","password":"secret1","role":"editor","hashed_password":"x"}`, "hashed_password"},
		{"delete user bad body", "admin", http.MethodDelete, "/api/v1/users/7",
			`{"transfer_to_id":"7"}`, "transfer_to_id"},
		// Taxonomy
		{"taxonomy term bad slug", "editor", http.MethodPost, "/api/v1/taxonomy/terms",
			`{"name":"News","slug":"Bad Slug","taxonomy_type_id":1}`, "slug"},
		{"taxonomy term long description", "editor", http.MethodPost, "/api/v1/taxonomy/terms",
			`{"name":"News","description":"` + longString(1001) + `","taxonomy_type_id":1}`, "description"},
		{"taxonomy type long description", "editor", http.MethodPost, "/api/v1/taxonomy/types",
			`{"name":"topics","label":"Topics","description":"` + longString(1001) + `"}`, "description"},
		// Post types
		{"post type path name", "admin", http.MethodPost, "/api/v1/post-types",
			`{"name":"../../x","label":"Products"}`, "name"},
		{"post type path slug", "admin", http.MethodPost, "/api/v1/post-types",
			`{"slug":"a/b","label":"Products"}`, "slug"},
		// Settings and themes
		{"settings bad url structure", "admin", http.MethodPut, "/api/v1/settings",
			`{"post_url_structure":"date"}`, "post_url_structure"},
		{"settings page size too large", "admin", http.MethodPut, "/api/v1/settings",
			`{"posts_per_page":1000}`, "posts_per_page"},
		{"extension setting bad key", "admin", http.MethodPut, "/api/v1/extension-settings",
			`{"key":"../x","value":1,"extension_type":"theme","extension_id":"example"}`, "key"},
		{"extension setting bad type", "admin", http.MethodPut, "/api/v1/extension-settings",
			`{"key":"k","value":1,"extension_type":"core","extension_id":"example"}`, "extension_type"},
		{"theme settings bad key", "admin", http.MethodPut, "/api/v1/themes/active/settings",
			`{"settings":{"a b":1}}`, ""},
		{"theme setting bad path key", "admin", http.MethodPut, "/api/v1/themes/1/settings/a%20b",
			`{"value":1}`, ""},
		// Sessions and collab
		{"login username too long", "", http.MethodPost, "/api/v1/auth/login",
			`{"username":"` + longString(51) + `","password":"secret1"}`, "username"},
		{"login unknown field", "", http.MethodPost, "/api/v1/auth/login",
			`{"username":"alice","password":"secret1","remember":true}`, "remember"},
		{"block session bad uuid", "editor", http.MethodPut, "/api/v1/sessions/block",
			`{"session_id":"nope"}`, ""},
		{"collab ticket doc too long", "editor", http.MethodPost, "/api/v1/collab/tickets",
			`{"doc":"` + longString(129) + `"}`, "doc"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)

			var user *db.User
			if tc.role != "" {
				u := validationTestUser(tc.role)
				user = &u
				stubRoleLookup(store, u)
			}

			server := newTestServer(t, store)
			recorder := sendAs(t, server, user, tc.method, tc.url, []byte(tc.body))

			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			body := decodeErrorBody(t, recorder)
			if tc.field != "" {
				require.Contains(t, body.Fields, tc.field, recorder.Body.String())
				require.Contains(t, body.Error, tc.field)
			}
		})
	}
}

// TestPostAcceptsAdminFormContent: the admin post form sends "content",
// which the API ignores; strict decoding must not reject it.
func TestPostAcceptsAdminFormContent(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	user := validationTestUser("editor")
	stubRoleLookup(store, user)

	post := db.Post{ID: 1, Title: "Old title", Url: "https://x.test/post/old", PostType: "post", PostStatus: "draft"}
	store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(post, nil)
	store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ any, arg db.UpdatePostParams) (db.Post, error) {
			require.Equal(t, "New title", arg.Title)
			post.Title = arg.Title
			return post, nil
		})

	server := newTestServer(t, store)
	recorder := sendAs(t, server, &user, http.MethodPut, "/api/v1/posts/1",
		[]byte(`{"title":"New title","url":"https://x.test/post/old","content":"<p>hi</p>","description":"A long enough description","post_status":"draft"}`))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
}

// TestUpdateUserUsernameFormat: a changed username must be what login
// accepts; resending an existing legacy one is allowed.
func TestUpdateUserUsernameFormat(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	user := validationTestUser("editor")
	stubRoleLookup(store, user)
	store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)

	server := newTestServer(t, store)
	recorder := sendAs(t, server, &user, http.MethodPut, fmt.Sprintf("/api/v1/users/%d", user.ID),
		[]byte(`{"username":"alice.smith"}`))
	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	require.Contains(t, decodeErrorBody(t, recorder).Fields, "username")
}

func blockDocBody(t *testing.T, doc map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"doc": doc})
	require.NoError(t, err)
	return body
}

// nestedPM returns a ProseMirror-style node nested depth levels deep.
func nestedPM(depth int) map[string]any {
	node := map[string]any{"type": "text", "text": "x"}
	for i := 0; i < depth; i++ {
		node = map[string]any{"type": "bulletList", "content": []any{node}}
	}
	return node
}

func TestUpdatePostBlocksLimits(t *testing.T) {
	manyBlocks := map[string]any{}
	order := []string{}
	for i := 0; i <= maxBlockDocBlocks; i++ {
		id := fmt.Sprintf("b%d", i)
		manyBlocks[id] = map[string]any{"type": "paragraph"}
		order = append(order, id)
	}

	testCases := []struct {
		name string
		body []byte
		code int
	}{
		{
			name: "TooDeep",
			body: blockDocBody(t, map[string]any{
				"doc_version":  1,
				"blocks_order": []string{"a"},
				"blocks":       map[string]any{"a": map[string]any{"type": "list", "attrs": map[string]any{"pm": nestedPM(60)}}},
			}),
			code: http.StatusBadRequest,
		},
		{
			name: "TooManyBlocks",
			body: blockDocBody(t, map[string]any{"doc_version": 1, "blocks_order": order, "blocks": manyBlocks}),
			code: http.StatusBadRequest,
		},
		{
			name: "BlockIDTooLong",
			body: blockDocBody(t, map[string]any{
				"doc_version":  1,
				"blocks_order": []string{},
				"blocks":       map[string]any{strings.Repeat("x", maxBlockIDLength+1): map[string]any{"type": "paragraph"}},
			}),
			code: http.StatusBadRequest,
		},
		{
			name: "TitleTooLong",
			body: []byte(`{"doc":{"doc_version":1,"blocks_order":[],"blocks":{}},"title":"` + strings.Repeat("t", 256) + `"}`),
			code: http.StatusBadRequest,
		},
		{
			name: "UnknownField",
			body: []byte(`{"doc":{"doc_version":1,"blocks_order":[],"blocks":{},"extra":1}}`),
			code: http.StatusBadRequest,
		},
		{
			name: "BodyTooLarge",
			body: []byte(`{"doc":{"doc_version":1,"blocks_order":[],"blocks":{"a":{"type":"p","text":"` +
				strings.Repeat("x", int(blockDocBodyLimit)) + `"}}}}`),
			code: http.StatusRequestEntityTooLarge,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			user := validationTestUser("editor")
			stubRoleLookup(store, user)
			store.EXPECT().UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).Times(0)

			server := newTestServer(t, store)
			request, err := http.NewRequest(http.MethodPut, "/api/v1/posts/1/blocks", bytes.NewReader(tc.body))
			require.NoError(t, err)
			request.Header.Set("If-Match", "1")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.code, recorder.Code, recorder.Body.String())
			decodeErrorBody(t, recorder)
		})
	}
}

// A realistically deep document (lists nested 20 levels) is still accepted.
func TestBlockDocLimitsAllowRealDocuments(t *testing.T) {
	doc := BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"a"},
		Blocks:      map[string]interface{}{"a": map[string]interface{}{"type": "list", "attrs": map[string]interface{}{"pm": nestedPM(20)}}},
	}
	// Round-trip through JSON so the tree has decoded types.
	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	var decoded BlockDocV1
	require.NoError(t, json.Unmarshal(raw, &decoded))
	require.NoError(t, decoded.checkLimits())
}

func TestDefaultBodyLimit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	user := validationTestUser("editor")
	stubRoleLookup(store, user)

	server := newTestServer(t, store)
	body := []byte(`{"meta_key":"k","meta_value":"` + strings.Repeat("x", int(defaultBodyLimit)) + `"}`)
	recorder := sendAs(t, server, &user, http.MethodPost, "/api/v1/posts/1/meta", body)
	require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code, recorder.Body.String())
	require.Equal(t, "request body too large", decodeErrorBody(t, recorder).Error)
}

// Upload routes keep their own (MAX_UPLOAD_SIZE) cap, not the 1 MiB default.
func TestBodyLimitExemptsUploads(t *testing.T) {
	for _, path := range []string{"/api/v1/media", "/api/v1/media/batch", "/api/v1/media/bulk", "/api/v1/media/:id/replace"} {
		limit, ok := bodyLimitOverrides["POST "+path]
		require.True(t, ok, path)
		require.Zero(t, limit, path)
	}
}

func TestBindJSONUnit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	type req struct {
		Name  string `json:"name" binding:"required,max=5"`
		Count int    `json:"count"`
	}

	testCases := []struct {
		name    string
		body    string
		ok      bool
		message string
	}{
		{"valid", `{"name":"abc","count":1}`, true, ""},
		{"whitespace after value", "{\"name\":\"abc\"}\n  ", true, ""},
		{"required", `{"count":1}`, false, "name is required"},
		{"too long", `{"name":"abcdef"}`, false, "name must be at most 5 characters"},
		{"unknown", `{"name":"a","x":1}`, false, `unknown field "x"`},
		{"type", `{"name":"a","count":"1"}`, false, "count must be an integer"},
		{"not an object", `[1]`, false, "request body must be a JSON object"},
		{"empty", ``, false, "request body is required"},
		{"trailing", `{"name":"a"} 1`, false, "request body must contain a single JSON value"},
		{"syntax", `{"name":}`, false, "request body is not valid JSON"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))

			var r req
			require.Equal(t, tc.ok, bindJSON(c, &r))
			if !tc.ok {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				var body errorBody
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, tc.message, body.Error)
			}
		})
	}
}

func TestBindOptionalJSONAllowsEmptyBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)

	var r PublishRequest
	require.True(t, bindOptionalJSON(c, &r))
	require.Nil(t, r.Label)
}

// Slugs the server generates must be accepted back as-is, and post_type only
// refuses path separators, so post types that predate the identifier rule
// keep working.
func TestSlugAndPostTypeRules(t *testing.T) {
	v := binding.Validator.Engine().(*validator.Validate)

	for _, name := range []string{"R&D", "C++ tips", "Café Noir", "hello_world"} {
		require.NoError(t, v.Var(generateSlug(name), "slug"), name)
	}
	for _, slug := range []string{"Bad", "a b", "a_b", "a--b", ""} {
		require.Error(t, v.Var(slug, "slug"), slug)
	}

	tag := "omitempty,max=50,excludesall=/\\"
	for _, postType := range []string{"post", "Product", "case.study"} {
		require.NoError(t, v.Var(postType, tag), postType)
	}
	for _, postType := range []string{"../etc", `a\b`} {
		require.Error(t, v.Var(postType, tag), postType)
	}
}

// A username with surrounding spaces is trimmed, then checked, as before #139.
func TestCreateUserTrimsUsernameBeforeFormatCheck(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	admin := validationTestUser("admin")
	stubRoleLookup(store, admin)
	store.EXPECT().CreateUser(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ any, arg db.CreateUserParams) (db.User, error) {
			require.Equal(t, "johndoe", arg.Username)
			return db.User{ID: 9, Username: arg.Username, Email: arg.Email, Role: arg.Role}, nil
		})

	server := newTestServer(t, store)
	recorder := sendAs(t, server, &admin, http.MethodPost, "/api/v1/users",
		[]byte(`{"username":" johndoe ","email":"j@example.com","full_name":"John","password":"secret1","role":"editor"}`))
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
}

func TestRespondBindErrorNamesBadFormNumber(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)

	_, err := strconv.ParseInt("abc", 10, 64)
	respondBindError(c, err)

	require.Equal(t, http.StatusBadRequest, recorder.Code)
	var body errorBody
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, `invalid number "abc" in form field`, body.Error)
}
