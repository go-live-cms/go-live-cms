package api

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// POST /embeds/resolve (#425, editors and up): what the editor asks when someone pastes a
// link. It says which allowed provider the link belongs to and the item's id, and looks up
// the item's title. This is the API's only outbound request made on a user's behalf, so it
// is built to be useless as a proxy (SSRF):
//
//   - Every URL it fetches comes from `embedProviderTable`'s literal endpoints; the request
//     only ever contributes a ref that matched its provider's pattern.
//   - HTTPS only, 3 s for the whole exchange, 64 KB read at most, and no redirect to another
//     host or to plain HTTP (at most 3 on the same host).
//   - No proxy from the environment, no cookies, and the dialer refuses loopback, private,
//     link-local, multicast and CGNAT addresses, so a poisoned DNS answer can't reach the
//     internal network either.
//   - Only the title is read. A title that can't be read costs nothing but the title: the
//     answer is still 200 and the editor lets the author type one.

const (
	embedFetchTimeout   = 3 * time.Second
	embedMaxAnswerBytes = 64 * 1024
	embedMaxRedirects   = 3
)

// embedNotAllowedMessage is the error on the canvas's "An embed link that isn't allowed".
const embedNotAllowedMessage = "An embed link that isn't allowed"

var (
	errEmbedRedirect = errors.New("embed: redirect refused")
	errEmbedAddress  = errors.New("embed: address refused")
)

var carrierGradeNAT = netip.MustParsePrefix("100.64.0.0/10")

// isPublicEmbedAddress: an address outside everything a server's own network uses.
func isPublicEmbedAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() &&
		!ip.IsInterfaceLocalMulticast() && !ip.IsMulticast() && !ip.IsUnspecified() && !carrierGradeNAT.Contains(ip)
}

// refuseNonPublicEmbedAddress is the dialer's check, run on the address DNS answered.
func refuseNonPublicEmbedAddress(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errEmbedAddress
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !isPublicEmbedAddress(ip) {
		return errEmbedAddress
	}
	return nil
}

// newEmbedTransport has no proxy and dials public addresses only.
func newEmbedTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: embedFetchTimeout, Control: refuseNonPublicEmbedAddress}
	return &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    embedFetchTimeout,
		ResponseHeaderTimeout:  embedFetchTimeout,
		MaxResponseHeaderBytes: embedMaxAnswerBytes,
		DisableKeepAlives:      true,
	}
}

// refuseOtherHostRedirects stops at anything but HTTPS on the host first asked.
func refuseOtherHostRedirects(req *http.Request, via []*http.Request) error {
	if len(via) > embedMaxRedirects || req.URL.Scheme != "https" || !strings.EqualFold(req.URL.Host, via[0].URL.Host) {
		return errEmbedRedirect
	}
	return nil
}

// newEmbedClient: `timeout` covers the whole exchange, the body included. A parameter (and
// the transport) so tests can run the real client against a fake server.
func newEmbedClient(transport http.RoundTripper, timeout time.Duration) *http.Client {
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: refuseOtherHostRedirects}
}

// fetchEmbedTitle asks the provider's fixed endpoint for the title. The second result is
// why there is none, a fixed word safe to log (the error text would hold the URL).
func (server *Server) fetchEmbedTitle(ctx context.Context, spec *embedProvider, ref string) (string, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.oEmbed(spec.canonical(ref)), nil)
	if err != nil || req.URL.Scheme != "https" {
		return "", "request"
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "GoLive-CMS (embed title)")

	resp, err := server.embedClient.Do(req)
	if err != nil {
		switch {
		case errors.Is(err, errEmbedRedirect):
			return "", "redirect"
		case errors.Is(err, errEmbedAddress):
			return "", "address"
		case isTimeout(err):
			return "", "timeout"
		default:
			return "", "network"
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "status"
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, embedMaxAnswerBytes+1))
	if err != nil {
		if isTimeout(err) {
			return "", "timeout"
		}
		return "", "network"
	}
	if len(body) > embedMaxAnswerBytes {
		return "", "too_large"
	}

	var answer embedOEmbedAnswer
	if err := json.Unmarshal(body, &answer); err != nil {
		return "", "decode"
	}
	return normalizeEmbedTitle(spec.title(answer)), ""
}

func isTimeout(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout())
}

type resolveEmbedRequest struct {
	URL string `json:"url" binding:"required,max=2048,http_url"`
}

type resolveEmbedResponse struct {
	Provider string `json:"provider"`
	Ref      string `json:"ref"`
	// Title is "" when the provider gave none; the author can type one.
	Title string `json:"title"`
}

func (server *Server) resolveEmbed(c *gin.Context) {
	var req resolveEmbedRequest
	if !bindJSON(c, &req) {
		return
	}

	settings, err := server.store.GetSettings(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the site's settings"})
		return
	}

	provider, ref, ok := matchEmbedURL(req.URL)
	if !ok || !slices.Contains(settings.EditorAllowedEmbeds, provider) {
		c.JSON(http.StatusBadRequest, gin.H{"error": embedNotAllowedMessage, "code": "embed_not_allowed"})
		return
	}

	title, failure := server.fetchEmbedTitle(c.Request.Context(), embedProviderTable[provider], ref)
	if failure != "" {
		server.requestLog(c).Warn("embed_title_failed", "provider", provider, "reason", failure)
	}
	c.JSON(http.StatusOK, resolveEmbedResponse{Provider: provider, Ref: ref, Title: title})
}

// registerEmbedRoutes: resolving is for editors and admins (auth_roles.go), who are the
// only roles offered the Embeds blocks. Listed in route_auth_test.go's embedRoutes.
func (server *Server) registerEmbedRoutes(rg *gin.RouterGroup) {
	embeds := rg.Group("/embeds", server.requireAuth(), requireContentEditor(server))
	embeds.POST("/resolve", server.resolveEmbed)
}
