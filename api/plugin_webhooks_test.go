package api

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Plugin webhooks (#460) without a database: the URL policy, the address guard, signing,
// and what a delivery does with each kind of answer.

const testWebhookSecret = "whsec-0123456789abcdef"

// fakeWebhookHost is a pluginsdk.Host with fixed settings.
type fakeWebhookHost struct{ settings map[string]any }

func (h fakeWebhookHost) Settings(context.Context) (map[string]any, error) { return h.settings, nil }
func (fakeWebhookHost) Posts() pluginsdk.PostReader                        { return nil }
func (fakeWebhookHost) Media() pluginsdk.MediaReader                       { return nil }
func (fakeWebhookHost) Users() pluginsdk.UserReader                        { return nil }
func (fakeWebhookHost) Log() *slog.Logger                                  { return slog.New(slog.DiscardHandler) }

var testWebhookSpec = PluginWebhook{URLSetting: "url", SecretSetting: "signing_secret"}

// webhookReceiver records what it received and answers with answer.
type webhookReceiver struct {
	mu       sync.Mutex
	requests []receivedWebhook
	answer   func(w http.ResponseWriter, r *http.Request)
}

type receivedWebhook struct {
	header http.Header
	body   []byte
}

func (rcv *webhookReceiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	rcv.mu.Lock()
	rcv.requests = append(rcv.requests, receivedWebhook{header: r.Header.Clone(), body: body})
	answer := rcv.answer
	rcv.mu.Unlock()
	// The answer may read the body again.
	r.Body = io.NopCloser(bytes.NewReader(body))
	if answer != nil {
		answer(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (rcv *webhookReceiver) received() []receivedWebhook {
	rcv.mu.Lock()
	defer rcv.mu.Unlock()
	return append([]receivedWebhook(nil), rcv.requests...)
}

// tlsReceiver is an HTTPS receiver on 127.0.0.1 and a sender that trusts it. Reaching a
// loopback address takes the development allowance; the real policy is tested below.
func tlsReceiver(t *testing.T) (*webhookReceiver, *httptest.Server, *webhookSender) {
	t.Helper()
	rcv := &webhookReceiver{}
	srv := httptest.NewTLSServer(rcv)
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return rcv, srv, newWebhookSender(true, pool)
}

func testWebhookEvent() pluginsdk.Event {
	return pluginsdk.Event{
		ID: 4242, PostID: 17, ActorID: 3, Name: pluginsdk.EventPostPublished,
		Data:       map[string]any{"post_type": "post", "version_id": float64(9)},
		OccurredAt: time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC),
	}
}

func deliverTo(sender *webhookSender, target string, event pluginsdk.Event) error {
	host := fakeWebhookHost{settings: map[string]any{"url": target, "signing_secret": testWebhookSecret}}
	return sender.observer("notify", testWebhookSpec)(context.Background(), host, event)
}

func TestWebhookDeliveryIsSigned(t *testing.T) {
	rcv, srv, sender := tlsReceiver(t)
	signedAt := time.Now()
	sender.now = func() time.Time { return signedAt }

	event := testWebhookEvent()
	require.NoError(t, deliverTo(sender, srv.URL+"/hooks?token=abc", event))
	got := rcv.received()
	require.Len(t, got, 1)
	req := got[0]

	require.Equal(t, "4242", req.header.Get(pluginsdk.WebhookHeaderEventID))
	require.Equal(t, "post.published", req.header.Get(pluginsdk.WebhookHeaderEvent))
	require.Equal(t, "application/json", req.header.Get("Content-Type"))
	require.Equal(t, webhookUserAgent, req.header.Get("User-Agent"))
	require.NoError(t, pluginsdk.VerifyWebhook(testWebhookSecret, req.header.Get(pluginsdk.WebhookHeaderTimestamp),
		req.header.Get(pluginsdk.WebhookHeaderSignature), req.body, time.Now(), 0))
	require.ErrorIs(t, pluginsdk.VerifyWebhook("another-secret-000", req.header.Get(pluginsdk.WebhookHeaderTimestamp),
		req.header.Get(pluginsdk.WebhookHeaderSignature), req.body, time.Now(), 0), pluginsdk.ErrWebhookSignature)
	require.Empty(t, req.header.Get("Cookie"))

	var payload map[string]any
	require.NoError(t, json.Unmarshal(req.body, &payload))
	require.Equal(t, map[string]any{
		"id": float64(4242), "event": "post.published", "plugin": "notify", "post_id": float64(17), "actor_id": float64(3),
		"data": map[string]any{"post_type": "post", "version_id": float64(9)}, "occurred_at": "2026-11-13T10:00:00Z",
	}, payload)

	// A retry carries the same id and body, signed again.
	signedAt = signedAt.Add(time.Minute)
	require.NoError(t, deliverTo(sender, srv.URL+"/hooks?token=abc", event))
	got = rcv.received()
	require.Len(t, got, 2)
	require.Equal(t, got[0].body, got[1].body, "the body is the event, the same on every attempt")
	require.Equal(t, "4242", got[1].header.Get(pluginsdk.WebhookHeaderEventID))
	require.NotEqual(t, got[0].header.Get(pluginsdk.WebhookHeaderSignature), got[1].header.Get(pluginsdk.WebhookHeaderSignature))
}

func TestWebhookPayloadWithoutActor(t *testing.T) {
	event := testWebhookEvent()
	event.ActorID, event.Data = 0, nil
	body, err := webhookBody("notify", event)
	require.NoError(t, err)
	require.Contains(t, string(body), `"actor_id":null`)
	require.Contains(t, string(body), `"data":{}`)
}

// requireNoLeak: a failure's message names neither the URL (it may hold a token) nor the
// secret.
func requireNoLeak(t *testing.T, err error, target string) {
	t.Helper()
	require.Error(t, err)
	u, _ := url.Parse(target)
	for _, leak := range []string{target, testWebhookSecret, u.Host, "token="} {
		require.NotContains(t, err.Error(), leak)
	}
}

func TestWebhookFailures(t *testing.T) {
	t.Run("a non-2xx answer", func(t *testing.T) {
		rcv, srv, sender := tlsReceiver(t)
		rcv.answer = func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }
		err := deliverTo(sender, srv.URL+"/?token=abc", testWebhookEvent())
		require.EqualError(t, err, "webhook answered HTTP 503")
		requireNoLeak(t, err, srv.URL+"/?token=abc")
	})

	t.Run("redirects are not followed, wherever they point", func(t *testing.T) {
		target := &webhookReceiver{}
		inner := httptest.NewTLSServer(target)
		defer inner.Close()
		for _, location := range []string{inner.URL + "/x", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/"} {
			rcv, srv, sender := tlsReceiver(t)
			rcv.answer = func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, location, http.StatusTemporaryRedirect)
			}
			err := deliverTo(sender, srv.URL, testWebhookEvent())
			require.EqualError(t, err, "webhook answered HTTP 307 (redirects are not followed)")
			require.Len(t, rcv.received(), 1)
		}
		require.Empty(t, target.received(), "the redirect's target was never reached")
	})

	t.Run("a receiver slower than the hook's timeout", func(t *testing.T) {
		rcv, srv, sender := tlsReceiver(t)
		rcv.answer = func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
		}
		host := fakeWebhookHost{settings: map[string]any{"url": srv.URL, "signing_secret": testWebhookSecret}}
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		defer cancel()
		started := time.Now()
		err := sender.observer("notify", testWebhookSpec)(ctx, host, testWebhookEvent())
		require.ErrorIs(t, err, webhookTimedOut)
		require.Less(t, time.Since(started), 3*time.Second)
	})

	t.Run("a certificate the API doesn't trust", func(t *testing.T) {
		_, srv, _ := tlsReceiver(t)
		err := deliverTo(newWebhookSender(true, nil), srv.URL, testWebhookEvent())
		require.ErrorIs(t, err, webhookTLSFailed)
	})

	t.Run("nothing listening", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		address := listener.Addr().String()
		listener.Close()
		err = deliverTo(newWebhookSender(true, nil), "http://"+address+"/", testWebhookEvent())
		require.ErrorIs(t, err, webhookNetworkFailed)
	})

	t.Run("settings not configured", func(t *testing.T) {
		sender := newWebhookSender(false, nil)
		observe := sender.observer("notify", testWebhookSpec)
		for settings, want := range map[string]error{
			`{}`:                                    webhookURLNotSet,
			`{"url": "  "}`:                         webhookURLNotSet,
			`{"url": "https://hooks.example.com/"}`: webhookSecretNotSet,
			`{"url": "https://hooks.example.com/", "signing_secret": "short"}`: webhookSecretShort,
		} {
			var values map[string]any
			require.NoError(t, json.Unmarshal([]byte(settings), &values))
			require.ErrorIs(t, observe(context.Background(), fakeWebhookHost{settings: values}, testWebhookEvent()), want, settings)
		}
	})
}

// The real policy: https only, and nothing internal, whether the URL names the address or
// DNS answers it.
func TestWebhookPolicyRefusesInternalTargets(t *testing.T) {
	rcv, srv, _ := tlsReceiver(t)
	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	require.NoError(t, err)
	sender := newWebhookSender(false, nil)

	for _, target := range []string{
		"https://127.0.0.1:" + port + "/",
		"https://[::1]:" + port + "/",
		"https://169.254.169.254/latest/meta-data/",
		"https://10.0.0.8/hook",
		"https://[::ffff:127.0.0.1]:" + port + "/",
		"https://[fd00:ec2::254]/",
		"http://hooks.example.com/",
	} {
		err := deliverTo(sender, target, testWebhookEvent())
		require.Error(t, err, target)
		require.True(t, strings.HasPrefix(err.Error(), "webhook URL refused: it "), "%s: %v", target, err)
	}
	// A name whose DNS answer is loopback: refused when connecting.
	err = deliverTo(sender, "https://localhost:"+port+"/?token=abc", testWebhookEvent())
	require.ErrorIs(t, err, webhookAddressRefuse)
	requireNoLeak(t, err, "https://localhost:"+port+"/?token=abc")
	require.Empty(t, rcv.received(), "the local receiver was never reached")

	transport := sender.client.Transport.(*http.Transport)
	require.Nil(t, transport.Proxy, "no proxy from the environment")
	require.True(t, transport.DisableKeepAlives)
}

func TestWebhookURLProblem(t *testing.T) {
	strict, dev := newWebhookSender(false, nil), newWebhookSender(true, nil)
	for raw, want := range map[string]string{
		"https://hooks.example.com/golive":           "",
		"https://hooks.example.com:8443/x?token=abc": "",
		"https://8.8.8.8/hook":                       "",
		"https://localhost/hook":                     "", // left to the dialer, which sees the DNS answer
		"http://hooks.example.com/":                  "must be an https URL",
		"ftp://hooks.example.com/":                   "must be an https URL",
		"hooks.example.com/x":                        "must be an absolute https URL",
		"https:///x":                                 "must be an absolute https URL",
		"https://user:pass@hooks.example.com/":       "must not contain a user name or password",
		"https://192.168.1.10/":                      "must not point to a private, local or reserved address",
		"https://[fe80::1]/":                         "must not point to a private, local or reserved address",
		"https://" + strings.Repeat("a", 2050) + "/": "must be at most 2048 characters",
	} {
		require.Equal(t, want, strict.urlProblem(raw), raw)
	}
	require.Empty(t, dev.urlProblem("http://127.0.0.1:9000/hook"), "the development allowance")
	require.Equal(t, "must be an https URL", dev.urlProblem("ftp://127.0.0.1/"))
}

func TestOutboundAddressGuard(t *testing.T) {
	for _, address := range []string{
		"0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.100.100.200", "127.0.0.1", "127.255.255.254",
		"169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.192", "192.0.2.1", "192.88.99.1",
		"192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.251", "239.255.255.250",
		"240.0.0.1", "255.255.255.255", "168.63.129.16",
		"::", "::1", "::127.0.0.1", "::ffff:10.0.0.1", "::ffff:0:a00:5", "::ffff:169.254.169.254", "64:ff9b::a00:1",
		"64:ff9b:1::1", "100::1", "2001::1", "2001:db8::1", "2002:a00:1::1", "fc00::1", "fd00:ec2::254",
		"fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1",
	} {
		ip, err := netip.ParseAddr(address)
		require.NoError(t, err, address)
		require.False(t, isPublicAddress(ip), address)
	}
	for _, address := range []string{"8.8.8.8", "1.1.1.1", "142.250.74.14", "172.32.0.1", "100.128.0.1", "2607:f8b0:4004:800::200e", "2a00:1450:4001:82a::200e", "::ffff:8.8.8.8"} {
		require.True(t, isPublicAddress(netip.MustParseAddr(address)), address)
	}
	require.ErrorIs(t, refuseNonPublicAddress("tcp", "no-port", nil), errAddressRefused)
	require.ErrorIs(t, refuseNonPublicAddress("tcp", "name.example:443", nil), errAddressRefused)
}

func TestWebhookPluginMismatch(t *testing.T) {
	webhook := PluginManifest{Server: PluginServer{
		Hooks:   []PluginHook{{Event: pluginsdk.EventPostPublished}},
		Webhook: &PluginWebhook{URLSetting: "url", SecretSetting: "secret"},
	}}
	require.Empty(t, pluginHooksMismatch(webhook, pluginsdk.Plugin{}, false), "a webhook plugin has no Go code")
	require.Contains(t, pluginHooksMismatch(webhook, pluginsdk.Plugin{Observers: map[string]pluginsdk.Observer{
		pluginsdk.EventPostPublished: func(context.Context, pluginsdk.Host, pluginsdk.Event) error { return nil },
	}}, true), "server.webhook")

	server := &Server{}
	plugin := server.webhookPlugin("notify", webhook)
	require.Equal(t, []string{pluginsdk.EventPostPublished}, plugin.HookEvents())
}

// NewServer refuses the development allowance outside debug mode, whatever built the
// config, and gives a debug server the insecure sender.
func TestNewServerWebhookAllowance(t *testing.T) {
	config := newTestServer(t, nil).config
	config.PluginWebhooksAllowInsecure = true
	_, err := NewServer(config, nil)
	require.ErrorContains(t, err, "PLUGIN_WEBHOOKS_ALLOW_INSECURE")

	config.PluginWebhooksAllowInsecure = false
	server, err := NewServer(config, nil)
	require.NoError(t, err)
	require.False(t, server.webhookSender().allowInsecure, "the strict policy by default")
	require.Equal(t, "must be an https URL", server.webhookSender().urlProblem("http://hooks.example.com/"))
}

func TestWebhookSettingProblem(t *testing.T) {
	server := &Server{}
	manifest := PluginManifest{Server: PluginServer{Webhook: &PluginWebhook{URLSetting: "url", SecretSetting: "signing_secret"}}}
	require.Empty(t, server.webhookSettingProblem(manifest, "url", "https://hooks.example.com/"))
	require.Empty(t, server.webhookSettingProblem(manifest, "url", ""), "unset is allowed")
	require.Equal(t, "must be an https URL", server.webhookSettingProblem(manifest, "url", "http://hooks.example.com/"))
	tooShort := "must be at least 16 characters, not only spaces"
	require.Equal(t, tooShort, server.webhookSettingProblem(manifest, "signing_secret", "short"))
	require.Equal(t, tooShort, server.webhookSettingProblem(manifest, "signing_secret", strings.Repeat(" ", 20)), "spaces aren't unset")
	require.Equal(t, tooShort, server.webhookSettingProblem(manifest, "signing_secret", "ééééééééé"), "counted in characters, not bytes")
	require.Empty(t, server.webhookSettingProblem(manifest, "signing_secret", testWebhookSecret))
	require.Empty(t, server.webhookSettingProblem(manifest, "other", "http://x"))
	require.Empty(t, server.webhookSettingProblem(PluginManifest{}, "url", "http://x"), "not a webhook plugin")
}
