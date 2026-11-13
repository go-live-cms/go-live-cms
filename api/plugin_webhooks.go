package api

// Plugin webhooks (#460, docs/design/plugin-system.md section 7.9): the hooks of a
// plugin with no Go code. A plugin.json with server.webhook names a URL setting and a
// secret setting; each hook it declares is delivered as a signed POST to that URL.
//
// Delivery is not a second runner. The dispatcher (plugin_hooks.go) builds a
// pluginsdk.Plugin for the webhook plugin whose every observer is deliverWebhook, so a
// webhook gets exactly what an in-process hook gets: the trigger's events, the fan-out,
// the FOR UPDATE SKIP LOCKED claim and its lease, per-post ordering, timeout_ms on the
// context, two slots per plugin, retries with the scheduler's backoff, at most 8
// attempts, plugin_hook_failed in the activity log, skipping once disabled. A 2xx
// answer is success; anything else (another status, a redirect, a timeout, a refused
// address, a URL or secret not set) is a failed attempt.
//
// Signing is pluginsdk.SignWebhook: HMAC-SHA256 over "<timestamp>.<raw body>", with the
// event id, event name, timestamp and signature in GoLive-* headers. The event id is the
// receiver's idempotency key (delivery is at least once).
//
// The SSRF policy (webhookSender):
//
//   - https only. PLUGIN_WEBHOOKS_ALLOW_INSECURE (GIN_MODE=debug only) allows http and
//     private addresses for a receiver on a developer's machine.
//   - No credentials in the URL, at most 2048 characters, checked when an admin saves
//     the setting and again before every delivery.
//   - The address check is the dialer's (outbound_http.go), on the address DNS answered
//     at connect time: loopback, private, link-local, CGNAT, multicast, metadata and
//     transition ranges, IPv6 and IPv4-mapped forms included. DNS rebinding can't get
//     around a check that runs on the connection itself.
//   - Redirects are never followed: a 3xx is a failed attempt.
//   - No proxy from the environment, no cookies, no keep-alives. The answer's headers
//     are capped and its body is never read.
//
// Secrets: the signing secret is only ever an HMAC key. The URL may hold a token too, so
// neither is logged, written to last_error or the activity log, or returned by the API
// (the secret setting is write-only, #457). Every failure is a fixed message.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

const (
	// webhookConnectTimeout bounds the dial and TLS handshake; the hook's timeout_ms
	// (on the context) bounds the whole attempt.
	webhookConnectTimeout = 5 * time.Second
	// webhookMaxHeaderBytes caps the answer's headers. The body is never read.
	webhookMaxHeaderBytes = 16 << 10
	// webhookURLMax is the longest URL accepted.
	webhookURLMax = 2048
	// webhookUserAgent identifies deliveries.
	webhookUserAgent = "GoLive-CMS-Webhook/1"
)

// webhookSender sends plugin webhooks under one policy.
type webhookSender struct {
	client *http.Client
	// allowInsecure is PLUGIN_WEBHOOKS_ALLOW_INSECURE: http and private addresses.
	allowInsecure bool
	// now is the signing clock (tests).
	now func() time.Time
}

// newWebhookSender builds the sender. rootCAs replaces the system roots (tests: a
// local TLS receiver's certificate); nil keeps them.
func newWebhookSender(allowInsecure bool, rootCAs *x509.CertPool) *webhookSender {
	var tlsConfig *tls.Config
	if rootCAs != nil {
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: rootCAs}
	}
	transport := newPublicOnlyTransport(outboundTransportOptions{
		connectTimeout: webhookConnectTimeout,
		maxHeaderBytes: webhookMaxHeaderBytes,
		allowPrivate:   allowInsecure,
		tls:            tlsConfig,
	})
	return &webhookSender{
		client: &http.Client{
			Transport: transport,
			// The hook's timeout is on the request's context; this is a backstop.
			Timeout: pluginHookMaxTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		allowInsecure: allowInsecure,
		now:           time.Now,
	}
}

// defaultWebhookSender is the strict policy's sender, built once, for a Server made by
// hand (tests) without one.
var defaultWebhookSender = sync.OnceValue(func() *webhookSender { return newWebhookSender(false, nil) })

// webhookSender is the server's sender, or the strict default. It never writes the
// field, so concurrent hook goroutines and handlers don't race on it.
func (server *Server) webhookSender() *webhookSender {
	if server.webhooks != nil {
		return server.webhooks
	}
	return defaultWebhookSender()
}

// webhookSecretProblem says why secret can't sign deliveries, or "" when it can: at
// least WebhookSecretMinLength characters, and not only whitespace.
func webhookSecretProblem(secret string) string {
	if strings.TrimSpace(secret) == "" || utf8.RuneCountInString(secret) < pluginsdk.WebhookSecretMinLength {
		return fmt.Sprintf("must be at least %d characters, not only spaces", pluginsdk.WebhookSecretMinLength)
	}
	return ""
}

// urlProblem says why raw can't be a webhook URL, or "" when it can. It never repeats
// the URL. The address a name resolves to is checked at connect time, not here.
func (s *webhookSender) urlProblem(raw string) string {
	if utf8.RuneCountInString(raw) > webhookURLMax {
		return fmt.Sprintf("must be at most %d characters", webhookURLMax)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Opaque != "" {
		return "must be an absolute https URL"
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && s.allowInsecure:
	default:
		return "must be an https URL"
	}
	if u.User != nil {
		return "must not contain a user name or password"
	}
	// Hostname() has no brackets; a name is left to the dialer, which sees its DNS answer.
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !s.allowInsecure && !isPublicAddress(ip) {
		return "must not point to a private, local or reserved address"
	}
	return ""
}

// webhookFailure is a failed delivery's message: fixed text, safe for last_error,
// the logs and the activity log.
type webhookFailure string

func (f webhookFailure) Error() string { return string(f) }

const (
	webhookURLNotSet     webhookFailure = "webhook URL is not set"
	webhookSecretNotSet  webhookFailure = "webhook signing secret is not set"
	webhookSecretShort   webhookFailure = "webhook signing secret is too short"
	webhookAddressRefuse webhookFailure = "webhook refused: the URL resolves to a private, local or reserved address"
	webhookTimedOut      webhookFailure = "webhook timed out"
	webhookTLSFailed     webhookFailure = "webhook TLS handshake failed"
	webhookNetworkFailed webhookFailure = "webhook request failed (network)"
)

// observer is the pluginsdk.Observer every hook of a webhook plugin runs: read the
// URL and secret from the plugin's settings, sign, send.
func (s *webhookSender) observer(slug string, webhook PluginWebhook) pluginsdk.Observer {
	return func(ctx context.Context, host pluginsdk.Host, event pluginsdk.Event) error {
		settings, err := host.Settings(ctx)
		if err != nil {
			return errors.New("reading the plugin's settings failed")
		}
		target, _ := settings[webhook.URLSetting].(string)
		secret, _ := settings[webhook.SecretSetting].(string)
		target = strings.TrimSpace(target)
		switch {
		case target == "":
			return webhookURLNotSet
		case secret == "":
			return webhookSecretNotSet
		case webhookSecretProblem(secret) != "":
			return webhookSecretShort
		}
		if problem := s.urlProblem(target); problem != "" {
			return webhookFailure("webhook URL refused: it " + problem)
		}
		return s.deliver(ctx, target, secret, slug, event)
	}
}

// webhookBody is the event's JSON (pluginsdk.WebhookPayload).
func webhookBody(slug string, event pluginsdk.Event) ([]byte, error) {
	payload := pluginsdk.WebhookPayload{
		ID: event.ID, Event: event.Name, Plugin: slug, PostID: event.PostID,
		Data: event.Data, OccurredAt: event.OccurredAt.UTC(),
	}
	if payload.Data == nil {
		payload.Data = map[string]any{}
	}
	if event.ActorID != 0 {
		actor := event.ActorID
		payload.ActorID = &actor
	}
	return json.Marshal(payload)
}

// deliver POSTs one signed event to target.
func (s *webhookSender) deliver(ctx context.Context, target, secret, slug string, event pluginsdk.Event) error {
	body, err := webhookBody(slug, event)
	if err != nil {
		return errors.New("encoding the webhook payload failed")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return webhookFailure("webhook URL refused: it must be an absolute https URL")
	}
	timestamp := s.now().Unix()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", webhookUserAgent)
	req.Header.Set(pluginsdk.WebhookHeaderEventID, strconv.FormatInt(event.ID, 10))
	req.Header.Set(pluginsdk.WebhookHeaderEvent, event.Name)
	req.Header.Set(pluginsdk.WebhookHeaderTimestamp, strconv.FormatInt(timestamp, 10))
	req.Header.Set(pluginsdk.WebhookHeaderSignature, pluginsdk.SignWebhook(secret, timestamp, body))

	resp, err := s.client.Do(req)
	if err != nil {
		return classifyWebhookError(err)
	}
	// The body is never read: nothing in it is used, and a receiver can't make the API
	// buffer anything.
	resp.Body.Close()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return webhookFailure(fmt.Sprintf("webhook answered HTTP %d (redirects are not followed)", resp.StatusCode))
	default:
		return webhookFailure(fmt.Sprintf("webhook answered HTTP %d", resp.StatusCode))
	}
}

// classifyWebhookError maps a client error to a fixed message: the error's own text
// holds the URL.
func classifyWebhookError(err error) error {
	var certErr *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameErr x509.HostnameError
	var invalidCert x509.CertificateInvalidError
	var recordErr tls.RecordHeaderError
	switch {
	case errors.Is(err, errAddressRefused):
		return webhookAddressRefuse
	case isTimeout(err):
		return webhookTimedOut
	case errors.As(err, &certErr), errors.As(err, &unknownAuthority), errors.As(err, &hostnameErr),
		errors.As(err, &invalidCert), errors.As(err, &recordErr):
		return webhookTLSFailed
	default:
		return webhookNetworkFailed
	}
}

// webhookPlugin is the server code the dispatcher runs for a webhook plugin: an
// observer per declared hook, each delivering to the URL.
func (server *Server) webhookPlugin(slug string, manifest PluginManifest) pluginsdk.Plugin {
	observer := server.webhookSender().observer(slug, *manifest.Server.Webhook)
	plugin := pluginsdk.Plugin{Observers: map[string]pluginsdk.Observer{}}
	for _, hook := range manifest.Server.Hooks {
		if slices.Contains(pluginsdk.ObserverEvents, hook.Event) {
			plugin.Observers[hook.Event] = observer
		}
	}
	return plugin
}

// webhookSettingProblem is the extra check PUT /plugins/:slug/settings makes on a
// webhook plugin's URL and secret fields, after the manifest's own rules. An empty
// value is allowed (not configured yet: deliveries fail until it is).
func (server *Server) webhookSettingProblem(manifest PluginManifest, name string, value any) string {
	webhook := manifest.Server.Webhook
	s, _ := value.(string)
	if webhook == nil || s == "" {
		return ""
	}
	switch name {
	case webhook.URLSetting:
		if strings.TrimSpace(s) == "" {
			return ""
		}
		return server.webhookSender().urlProblem(strings.TrimSpace(s))
	case webhook.SecretSetting:
		// A secret of spaces is not "unset": it would sign with a guessable key.
		return webhookSecretProblem(s)
	}
	return ""
}
