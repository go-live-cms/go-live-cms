package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

type embedVectors struct {
	Providers []string `json:"providers"`
	URLs      struct {
		Accept []struct {
			URL      string `json:"url"`
			Provider string `json:"provider"`
			Ref      string `json:"ref"`
		} `json:"accept"`
		Reject []string `json:"reject"`
	} `json:"urls"`
	Refs map[string]struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"refs"`
	Canonical []struct {
		Provider string `json:"provider"`
		Ref      string `json:"ref"`
		URL      string `json:"url"`
	} `json:"canonical"`
	Titles []struct {
		In  string  `json:"in"`
		Out *string `json:"out"`
	} `json:"titles"`
}

func loadEmbedVectors(t *testing.T) embedVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "web", "gl-admin", "lib", "blocks-spec", "embedVectors.json"))
	require.NoError(t, err)
	var vectors embedVectors
	require.NoError(t, json.Unmarshal(raw, &vectors))
	return vectors
}

func TestEmbedVectors_Providers(t *testing.T) {
	vectors := loadEmbedVectors(t)
	require.Equal(t, vectors.Providers, embedProviders, "embedProviders and Block Spec's list differ")
	require.Len(t, embedProviderTable, len(embedProviders))
	for _, id := range embedProviders {
		require.Contains(t, embedProviderTable, id)
		require.Contains(t, vectors.Refs, id, "no ref vectors for %s", id)
	}
}

func TestEmbedVectors_URLs(t *testing.T) {
	vectors := loadEmbedVectors(t)
	for _, tc := range vectors.URLs.Accept {
		t.Run("accepts "+tc.URL, func(t *testing.T) {
			provider, ref, ok := matchEmbedURL(tc.URL)
			require.True(t, ok)
			require.Equal(t, tc.Provider, provider)
			require.Equal(t, tc.Ref, ref)
		})
	}
	for _, raw := range vectors.URLs.Reject {
		t.Run("rejects "+raw, func(t *testing.T) {
			_, _, ok := matchEmbedURL(raw)
			require.False(t, ok)
		})
	}
}

func TestEmbedVectors_Refs(t *testing.T) {
	for provider, refs := range loadEmbedVectors(t).Refs {
		for _, ref := range refs.Valid {
			require.True(t, validEmbedRef(provider, ref), "%s %q", provider, ref)
		}
		for _, ref := range refs.Invalid {
			require.False(t, validEmbedRef(provider, ref), "%s %q", provider, ref)
		}
	}
	require.False(t, validEmbedRef("tiktok", "dQw4w9WgXcQ"), "an unknown provider has no valid refs")
}

func TestEmbedVectors_Canonical(t *testing.T) {
	for _, tc := range loadEmbedVectors(t).Canonical {
		require.Equal(t, tc.URL, embedProviderTable[tc.Provider].canonical(tc.Ref))
		provider, ref, ok := matchEmbedURL(tc.URL)
		require.True(t, ok, "%s must resolve to itself", tc.URL)
		require.Equal(t, tc.Provider, provider)
		require.Equal(t, tc.Ref, ref)
	}
}

func TestEmbedVectors_Titles(t *testing.T) {
	for _, tc := range loadEmbedVectors(t).Titles {
		want := ""
		if tc.Out != nil {
			want = *tc.Out
		}
		require.Equal(t, want, normalizeEmbedTitle(tc.In), "title %q", tc.In)
	}
}

// Every endpoint the API may fetch is a literal on HTTPS, whatever the ref.
func TestEmbedProviderEndpointsAreFixedHTTPS(t *testing.T) {
	hosts := map[string]string{
		"youtube": "www.youtube.com", "vimeo": "vimeo.com", "x": "publish.x.com",
		"codepen": "codepen.io", "soundcloud": "soundcloud.com", "spotify": "open.spotify.com",
	}
	for id, spec := range embedProviderTable {
		target := spec.oEmbed("https://evil.example/?a=b&host=x#y")
		req, err := http.NewRequest(http.MethodGet, target, nil)
		require.NoError(t, err)
		require.Equal(t, "https", req.URL.Scheme, id)
		require.Equal(t, hosts[id], req.URL.Host, id)
		require.Equal(t, "https://evil.example/?a=b&host=x#y", req.URL.Query().Get("url"), "%s: the item's URL is only ever a query value", id)
	}
}

func TestSanitize_EmbedAttrs(t *testing.T) {
	t.Run("keeps its own attrs only", func(t *testing.T) {
		doc := singleBlock("embed", map[string]interface{}{
			"provider": "youtube", "ref": "dQw4w9WgXcQ", "title": "  Two editors\t", "src": "https://evil.example", "html": "<iframe>", "onload": "x",
			"caption": []interface{}{
				map[string]interface{}{"type": "text", "text": "A demo", "marks": []interface{}{map[string]interface{}{"type": "highlight"}}},
				map[string]interface{}{"type": "image"},
			},
		})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{
			"provider": "youtube", "ref": "dQw4w9WgXcQ", "title": "Two editors",
			"caption": []interface{}{map[string]interface{}{"type": "text", "text": "A demo"}},
		}, attrsOf(doc))
	})

	t.Run("refuses bad refs, per provider", func(t *testing.T) {
		for provider, refs := range loadEmbedVectors(t).Refs {
			for _, ref := range refs.Invalid {
				doc := singleBlock("embed", map[string]interface{}{"provider": provider, "ref": ref})
				doc.sanitize()
				require.Equal(t, map[string]interface{}{"provider": provider}, attrsOf(doc), "%s %q", provider, ref)
			}
			for _, ref := range refs.Valid {
				doc := singleBlock("embed", map[string]interface{}{"provider": provider, "ref": ref})
				doc.sanitize()
				require.Equal(t, ref, attrsOf(doc)["ref"], "%s %q", provider, ref)
			}
		}
	})

	t.Run("a ref of another provider's shape is refused", func(t *testing.T) {
		doc := singleBlock("embed", map[string]interface{}{"provider": "vimeo", "ref": "dQw4w9WgXcQ"})
		doc.sanitize()
		require.NotContains(t, attrsOf(doc), "ref")
	})

	t.Run("an unknown provider loses the ref too", func(t *testing.T) {
		for _, provider := range []interface{}{"tiktok", "", 12, nil, true} {
			doc := singleBlock("embed", map[string]interface{}{"provider": provider, "ref": "dQw4w9WgXcQ"})
			doc.sanitize()
			require.Empty(t, attrsOf(doc), "provider %v", provider)
		}
	})

	t.Run("a non-string ref is dropped", func(t *testing.T) {
		for _, ref := range []interface{}{12, true, nil, []interface{}{"dQw4w9WgXcQ"}} {
			doc := singleBlock("embed", map[string]interface{}{"provider": "youtube", "ref": ref})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "ref", "ref %v", ref)
		}
	})

	t.Run("refuses HTML titles and non-strings", func(t *testing.T) {
		for _, title := range []interface{}{"<b>x</b>", "a<script>alert(1)</script>", "<img src=x>", 12, true, map[string]interface{}{}} {
			doc := singleBlock("embed", map[string]interface{}{"provider": "youtube", "title": title})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "title", "title %v", title)
		}
	})

	t.Run("caps the title in code points", func(t *testing.T) {
		doc := singleBlock("embed", map[string]interface{}{"provider": "youtube", "title": strings.Repeat("é", embedTitleMaxRunes+50)})
		doc.sanitize()
		require.Equal(t, embedTitleMaxRunes, utf8.RuneCountInString(attrsOf(doc)["title"].(string)))
	})

	t.Run("is an empty block's attrs as they are", func(t *testing.T) {
		doc := singleBlock("embed", map[string]interface{}{"provider": "x"})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"provider": "x"}, attrsOf(doc))
	})
}

// --- the route -----------------------------------------------------------------------

const fakeOEmbedAnswer = `{"title":"Two editors, one draft","author_name":"Ana","html":"<iframe src=\"https://evil.example\"></iframe>"}`

// fakeOEmbed is a TLS server that answers for every provider: the real client talks to it
// through a transport that dials it whatever the host (the URL, its Host header and the
// redirect rule stay the real ones), recording what it was asked.
type fakeOEmbed struct {
	server *httptest.Server
	mu     sync.Mutex
	asked  []*http.Request
}

func newFakeOEmbed(t *testing.T, handler http.HandlerFunc) *fakeOEmbed {
	t.Helper()
	fake := &fakeOEmbed{}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		fake.asked = append(fake.asked, r.Clone(context.Background()))
		fake.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (fake *fakeOEmbed) requests() []*http.Request {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]*http.Request(nil), fake.asked...)
}

func (fake *fakeOEmbed) client(timeout time.Duration) *http.Client {
	address := fake.server.Listener.Addr().String()
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, // the fake's own certificate
		DisableKeepAlives: true,
	}
	return newEmbedClient(transport, timeout)
}

func embedTestServer(t *testing.T, role string, allowed []string, client *http.Client) (*Server, db.User, *mockdb.MockStore) {
	t.Helper()
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	if client != nil {
		server.embedClient = client
	}
	user := db.User{ID: 41, Username: "embedder", Role: role}
	store.EXPECT().GetUser(gomock.Any(), user.ID).AnyTimes().Return(user, nil)
	store.EXPECT().GetSettings(gomock.Any()).AnyTimes().Return(db.Setting{EditorAllowedEmbeds: allowed}, nil)
	return server, user, store
}

func postResolve(t *testing.T, server *Server, user db.User, url string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"url": url})
	require.NoError(t, err)
	return postResolveBody(t, server, user, body)
}

func postResolveBody(t *testing.T, server *Server, user db.User, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/embeds/resolve", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func requireResolved(t *testing.T, recorder *httptest.ResponseRecorder, provider, ref, title string) {
	t.Helper()
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var got resolveEmbedResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &got))
	require.Equal(t, resolveEmbedResponse{Provider: provider, Ref: ref, Title: title}, got)
}

func requireNotAllowed(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	var got struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &got))
	require.Equal(t, "embed_not_allowed", got.Code)
	require.Equal(t, "An embed link that isn't allowed", got.Error)
}

func TestResolveEmbed_Roles(t *testing.T) {
	const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	for role, want := range map[string]int{RoleAdmin: http.StatusOK, RoleEditor: http.StatusOK, RoleContributor: http.StatusForbidden} {
		t.Run(role, func(t *testing.T) {
			fake := newFakeOEmbed(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, fakeOEmbedAnswer) })
			server, user, _ := embedTestServer(t, role, []string{"youtube"}, fake.client(time.Second))
			recorder := postResolve(t, server, user, link)
			require.Equal(t, want, recorder.Code, recorder.Body.String())
			if want != http.StatusOK {
				require.Empty(t, fake.requests(), "refused before anything was fetched")
			}
		})
	}
}

func TestResolveEmbed_AsksTheFixedEndpointWithTheRebuiltURL(t *testing.T) {
	tests := []struct {
		name, paste, provider, ref, host, path, queried string
		answer, title                                   string
	}{
		{name: "youtube", paste: "https://youtu.be/dQw4w9WgXcQ?si=tracking", provider: "youtube", ref: "dQw4w9WgXcQ", host: "www.youtube.com", path: "/oembed", queried: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", answer: fakeOEmbedAnswer, title: "Two editors, one draft"},
		{name: "vimeo", paste: "https://vimeo.com/76979871", provider: "vimeo", ref: "76979871", host: "vimeo.com", path: "/api/oembed.json", queried: "https://vimeo.com/76979871", answer: fakeOEmbedAnswer, title: "Two editors, one draft"},
		{name: "x titles a post by its author", paste: "https://twitter.com/jack/status/20", provider: "x", ref: "20", host: "publish.x.com", path: "/oembed", queried: "https://x.com/i/status/20", answer: `{"author_name":"jack","title":"ignored"}`, title: "Post by jack"},
		{name: "codepen", paste: "https://codepen.io/a/pen/b1", provider: "codepen", ref: "a/b1", host: "codepen.io", path: "/api/oembed", queried: "https://codepen.io/a/pen/b1", answer: fakeOEmbedAnswer, title: "Two editors, one draft"},
		{name: "soundcloud", paste: "https://soundcloud.com/forss/flickermood", provider: "soundcloud", ref: "forss/flickermood", host: "soundcloud.com", path: "/oembed", queried: "https://soundcloud.com/forss/flickermood", answer: fakeOEmbedAnswer, title: "Two editors, one draft"},
		{name: "spotify", paste: "https://open.spotify.com/intl-pt/track/4cOdK2wGLETKBW3PvgPWqT?si=x", provider: "spotify", ref: "track/4cOdK2wGLETKBW3PvgPWqT", host: "open.spotify.com", path: "/oembed", queried: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", answer: fakeOEmbedAnswer, title: "Two editors, one draft"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeOEmbed(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, tc.answer) })
			server, user, _ := embedTestServer(t, RoleEditor, []string{tc.provider}, fake.client(time.Second))
			requireResolved(t, postResolve(t, server, user, tc.paste), tc.provider, tc.ref, tc.title)

			asked := fake.requests()
			require.Len(t, asked, 1)
			require.Equal(t, tc.host, asked[0].Host)
			require.Equal(t, tc.path, asked[0].URL.Path)
			require.Equal(t, tc.queried, asked[0].URL.Query().Get("url"), "the item's URL comes from the ref, never from the paste")
		})
	}
}

func TestResolveEmbed_RefusesWithoutFetching(t *testing.T) {
	fake := newFakeOEmbed(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, fakeOEmbedAnswer) })

	t.Run("a URL that matches no provider", func(t *testing.T) {
		server, user, _ := embedTestServer(t, RoleEditor, embedProviders, fake.client(time.Second))
		for _, raw := range []string{
			"https://www.tiktok.com/@a/video/1",
			"https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
			"http://169.254.169.254/latest/meta-data/",
			"http://localhost:8081/internal/users/1/access",
			"https://youtube.com@127.0.0.1/watch?v=dQw4w9WgXcQ",
		} {
			requireNotAllowed(t, postResolve(t, server, user, raw))
		}
	})

	t.Run("a provider the site doesn't allow", func(t *testing.T) {
		server, user, _ := embedTestServer(t, RoleEditor, []string{"vimeo"}, fake.client(time.Second))
		requireNotAllowed(t, postResolve(t, server, user, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
	})

	t.Run("nothing allowed", func(t *testing.T) {
		server, user, _ := embedTestServer(t, RoleEditor, []string{}, fake.client(time.Second))
		requireNotAllowed(t, postResolve(t, server, user, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
	})

	require.Empty(t, fake.requests())
}

func TestResolveEmbed_BadRequests(t *testing.T) {
	server, user, _ := embedTestServer(t, RoleEditor, embedProviders, nil)
	for _, body := range []string{`{}`, `{"url":""}`, `{"url":"javascript:alert(1)"}`, `{"url":"https://youtu.be/dQw4w9WgXcQ","extra":1}`, `not json`} {
		require.Equal(t, http.StatusBadRequest, postResolveBody(t, server, user, []byte(body)).Code, body)
	}
	long, err := json.Marshal(map[string]string{"url": "https://youtu.be/" + strings.Repeat("a", 2100)})
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, postResolveBody(t, server, user, long).Code)
}

func TestResolveEmbed_SettingsFailure(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	user := db.User{ID: 41, Username: "embedder", Role: RoleEditor}
	store.EXPECT().GetUser(gomock.Any(), user.ID).AnyTimes().Return(user, nil)
	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
	require.Equal(t, http.StatusInternalServerError, postResolve(t, server, user, "https://youtu.be/dQw4w9WgXcQ").Code)
}

func TestEmbedFetchLimits(t *testing.T) {
	require.Equal(t, 3*time.Second, embedFetchTimeout)
	require.Equal(t, 64*1024, embedMaxAnswerBytes)
}

const youtubeLink = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

func TestResolveEmbed_TitleLimits(t *testing.T) {
	jsonOfSize := func(size int) string {
		wrapper := `{"title":"Sized","pad":""}`
		return `{"title":"Sized","pad":"` + strings.Repeat("x", size-len(wrapper)) + `"}`
	}

	tests := []struct {
		name    string
		handler http.HandlerFunc
		timeout time.Duration
		title   string
	}{
		{
			name:    "an answer of exactly the cap is read",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, jsonOfSize(embedMaxAnswerBytes)) },
			title:   "Sized",
		},
		{
			name:    "one byte over the cap costs the title",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, jsonOfSize(embedMaxAnswerBytes+1)) },
		},
		{
			name: "a slow header costs the title",
			handler: func(_ http.ResponseWriter, r *http.Request) {
				<-r.Context().Done()
			},
			timeout: 150 * time.Millisecond,
		},
		{
			name: "a body that stalls costs the title",
			handler: func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, `{"title":"Half`)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			},
			timeout: 150 * time.Millisecond,
		},
		{
			name:    "a provider error costs the title",
			handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) },
		},
		{
			name:    "an answer that isn't JSON costs the title",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `<!DOCTYPE html><title>Blocked</title>`) },
		},
		{
			name:    "a title that isn't a string costs the title",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"title":{"a":1}}`) },
		},
		{
			name:    "an HTML title is never kept",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"title":"<script>alert(1)</script>"}`) },
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeOEmbed(t, tc.handler)
			timeout := tc.timeout
			if timeout == 0 {
				timeout = 5 * time.Second
			}
			server, user, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, fake.client(timeout))
			started := time.Now()
			requireResolved(t, postResolve(t, server, user, youtubeLink), "youtube", "dQw4w9WgXcQ", tc.title)
			if tc.timeout != 0 {
				require.Less(t, time.Since(started), 3*time.Second, "the timeout ended it")
			}
		})
	}
}

func TestResolveEmbed_Redirects(t *testing.T) {
	const answerPath = "/answered"

	t.Run("to another host is refused and never asked", func(t *testing.T) {
		fake := newFakeOEmbed(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Host != "www.youtube.com" {
				fmt.Fprint(w, fakeOEmbedAnswer)
				return
			}
			http.Redirect(w, r, "https://evil.example/oembed", http.StatusFound)
		})
		server, user, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, fake.client(time.Second))
		requireResolved(t, postResolve(t, server, user, youtubeLink), "youtube", "dQw4w9WgXcQ", "")
		require.Len(t, fake.requests(), 1, "evil.example was never asked")
	})

	t.Run("to plain HTTP on the same host is refused", func(t *testing.T) {
		fake := newFakeOEmbed(t, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "http://www.youtube.com/oembed", http.StatusMovedPermanently)
		})
		server, user, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, fake.client(time.Second))
		requireResolved(t, postResolve(t, server, user, youtubeLink), "youtube", "dQw4w9WgXcQ", "")
		require.Len(t, fake.requests(), 1)
	})

	t.Run("on the same host over HTTPS is followed", func(t *testing.T) {
		fake := newFakeOEmbed(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == answerPath {
				fmt.Fprint(w, fakeOEmbedAnswer)
				return
			}
			http.Redirect(w, r, "https://www.youtube.com"+answerPath, http.StatusFound)
		})
		server, user, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, fake.client(time.Second))
		requireResolved(t, postResolve(t, server, user, youtubeLink), "youtube", "dQw4w9WgXcQ", "Two editors, one draft")
		require.Len(t, fake.requests(), 2)
	})

	t.Run("a chain is cut off after embedMaxRedirects", func(t *testing.T) {
		fake := newFakeOEmbed(t, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, fmt.Sprintf("https://www.youtube.com/next%d", len(r.URL.Path)), http.StatusFound)
		})
		server, user, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, fake.client(time.Second))
		requireResolved(t, postResolve(t, server, user, youtubeLink), "youtube", "dQw4w9WgXcQ", "")
		require.LessOrEqual(t, len(fake.requests()), embedMaxRedirects+1)
	})
}

func TestEmbedDialRefusesInternalAddresses(t *testing.T) {
	refused := []string{
		"127.0.0.1:443", "[::1]:443", "10.0.0.5:443", "172.16.0.9:443", "192.168.1.1:443", "169.254.169.254:80",
		"100.64.0.1:443", "0.0.0.0:443", "[::]:443", "[fe80::1]:443", "[fc00::1]:443", "224.0.0.1:443", "[::ffff:127.0.0.1]:443", "not-an-address",
	}
	for _, address := range refused {
		require.ErrorIs(t, refuseNonPublicEmbedAddress("tcp", address, nil), errEmbedAddress, address)
	}
	for _, address := range []string{"142.250.74.14:443", "[2607:f8b0:4004:800::200e]:443"} {
		require.NoError(t, refuseNonPublicEmbedAddress("tcp", address, nil), address)
	}
	require.False(t, isPublicEmbedAddress(netip.Addr{}))
}

// The real transport never reaches a local server, whatever the URL says.
func TestEmbedClientCantReachLocalServers(t *testing.T) {
	local := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the local server was reached")
	}))
	defer local.Close()

	transport := newEmbedTransport()
	require.Nil(t, transport.Proxy, "no proxy from the environment")
	client := newEmbedClient(transport, time.Second)
	_, err := client.Get(local.URL)
	require.ErrorIs(t, err, errEmbedAddress)
}

func TestFetchEmbedTitle_ClassifiesFailures(t *testing.T) {
	spec := embedProviderTable["youtube"]
	fake := newFakeOEmbed(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example/", http.StatusFound)
	})
	server := &Server{embedClient: fake.client(time.Second)}
	title, why := server.fetchEmbedTitle(context.Background(), spec, "dQw4w9WgXcQ")
	require.Empty(t, title)
	require.Equal(t, "redirect", why)

	server.embedClient = newEmbedClient(newEmbedTransport(), time.Second)
	fakeResolver := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	})}
	server.embedClient = fakeResolver
	_, why = server.fetchEmbedTitle(context.Background(), spec, "dQw4w9WgXcQ")
	require.Equal(t, "network", why)

	server.embedClient = &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, errEmbedAddress
	})}
	_, why = server.fetchEmbedTitle(context.Background(), spec, "dQw4w9WgXcQ")
	require.Equal(t, "address", why)

	server.embedClient = &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, context.DeadlineExceeded
	})}
	_, why = server.fetchEmbedTitle(context.Background(), spec, "dQw4w9WgXcQ")
	require.Equal(t, "timeout", why)
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// --- what the public site receives ------------------------------------------------------

func embedDoc(t *testing.T, provider, ref string) map[string]interface{} {
	t.Helper()
	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(fmt.Sprintf(`{"doc_version":1,"blocks_order":["group-0001","embed-0002"],"blocks":{
		"group-0001":{"id":"group-0001","type":"group","version":1,"attrs":{},"children":["embed-0001"]},
		"embed-0001":{"id":"embed-0001","type":"embed","version":1,"attrs":{"provider":%q,"ref":%q,"title":"In a group","caption":[{"type":"text","text":"Caption"}]}},
		"embed-0002":{"id":"embed-0002","type":"embed","version":1,"attrs":{"provider":%q,"ref":%q,"title":"Top"}}
	}}`, provider, ref, provider, ref)), &doc))
	return doc
}

func attrsOfBlock(doc map[string]interface{}, id string) map[string]interface{} {
	return doc["blocks"].(map[string]interface{})[id].(map[string]interface{})["attrs"].(map[string]interface{})
}

// The acceptance item, through the route the public site reads: a provider taken off the
// list stops its blocks at once, and allowing it again brings them back, the snapshot
// untouched.
func TestPublicBlocksFollowAllowedEmbeds(t *testing.T) {
	published, err := json.Marshal(embedDoc(t, "youtube", "dQw4w9WgXcQ"))
	require.NoError(t, err)

	read := func(t *testing.T, allowed []string) map[string]interface{} {
		t.Helper()
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPublishedPostBlocks(gomock.Any(), int64(1)).Return(db.GetPublishedPostBlocksRow{Content: pqtype.NullRawMessage{RawMessage: published, Valid: true}, PostStatus: "published"}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{EditorAllowedEmbeds: allowed}, nil)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/public/posts/1/blocks", nil))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp struct {
			Doc map[string]interface{} `json:"doc"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		return resp.Doc
	}

	allowed := read(t, []string{"youtube"})
	require.Equal(t, "dQw4w9WgXcQ", attrsOfBlock(allowed, "embed-0002")["ref"])

	removed := read(t, []string{"vimeo"})
	require.Empty(t, attrsOfBlock(removed, "embed-0001"))
	require.Empty(t, attrsOfBlock(removed, "embed-0002"))
	require.NotContains(t, fmt.Sprint(removed), "dQw4w9WgXcQ")

	again := read(t, []string{"youtube"})
	require.Equal(t, "In a group", attrsOfBlock(again, "embed-0001")["title"])
}

func TestHideDisallowedEmbeds(t *testing.T) {
	const ref = "dQw4w9WgXcQ"

	t.Run("an allowed provider's blocks are left alone, at any depth", func(t *testing.T) {
		server, _, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, nil)
		doc := embedDoc(t, "youtube", ref)
		server.hideDisallowedEmbeds(context.Background(), doc)
		require.Equal(t, "youtube", attrsOfBlock(doc, "embed-0001")["provider"])
		require.Equal(t, ref, attrsOfBlock(doc, "embed-0002")["ref"])
		require.Equal(t, "In a group", attrsOfBlock(doc, "embed-0001")["title"])
	})

	t.Run("a provider no longer allowed loses everything, at any depth", func(t *testing.T) {
		server, _, _ := embedTestServer(t, RoleEditor, []string{"vimeo"}, nil)
		doc := embedDoc(t, "youtube", ref)
		server.hideDisallowedEmbeds(context.Background(), doc)
		require.Empty(t, attrsOfBlock(doc, "embed-0001"))
		require.Empty(t, attrsOfBlock(doc, "embed-0002"))
		blocks := doc["blocks"].(map[string]interface{})
		require.Contains(t, blocks, "embed-0001", "the block keeps its place")
	})

	t.Run("an invalid ref renders nothing even from an allowed provider", func(t *testing.T) {
		server, _, _ := embedTestServer(t, RoleEditor, []string{"youtube"}, nil)
		doc := embedDoc(t, "youtube", "not-a-valid-id")
		server.hideDisallowedEmbeds(context.Background(), doc)
		require.Empty(t, attrsOfBlock(doc, "embed-0002"))
	})

	t.Run("a failed settings lookup hides every embed", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
		doc := embedDoc(t, "youtube", ref)
		server.hideDisallowedEmbeds(context.Background(), doc)
		require.Empty(t, attrsOfBlock(doc, "embed-0002"))
	})

	t.Run("a doc with no embed costs no lookup", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t)) // no GetSettings expected
		server := newTestServer(t, store)
		doc := map[string]interface{}{"blocks": map[string]interface{}{
			"para-00001": map[string]interface{}{"id": "para-00001", "type": "paragraph", "attrs": map[string]interface{}{"text": "x"}},
			"not-a-map":  "x",
		}}
		server.hideDisallowedEmbeds(context.Background(), doc, nil)
	})
}
