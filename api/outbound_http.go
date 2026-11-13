package api

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// The API's outbound HTTP guard (SSRF), shared by its two outbound requests: the embed
// title lookup (embeds_resolve.go, #425) and plugin webhook delivery
// (plugin_webhooks.go, #460). Both dial through newPublicOnlyTransport:
//
//   - The address check runs in the dialer's Control hook, on the address actually being
//     connected to, after DNS. A name that resolves to an internal address is refused
//     however it got there, and DNS rebinding (a public answer when a URL is checked, a
//     private one when it's fetched) can't get around it, because nothing is checked
//     ahead of the connection.
//   - No proxy from the environment (HTTP_PROXY would send the request, and the decision
//     about where it goes, to another host), no keep-alives, TLS 1.2 or later.
//
// Redirects, timeouts and how much of an answer is read are each caller's own.

// errAddressRefused: the dialer refused a non-public address.
var errAddressRefused = errors.New("outbound: address refused")

// nonPublicPrefixes are every range a server's own network, the host itself or a cloud
// provider's metadata service can be reached at, plus the ranges that are never a real
// destination. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are unmapped before the check;
// the transition ranges that embed an IPv4 address in another form (NAT64, 6to4, Teredo,
// IPv4-compatible) are refused whole, since what they reach depends on the network.
var nonPublicPrefixes = func() []netip.Prefix {
	ranges := []string{
		// IPv4.
		"0.0.0.0/8",        // "this network"
		"10.0.0.0/8",       // private
		"100.64.0.0/10",    // carrier-grade NAT (also Alibaba's metadata, 100.100.100.200)
		"127.0.0.0/8",      // loopback
		"169.254.0.0/16",   // link-local (AWS, GCP, Azure, DigitalOcean metadata at .169.254)
		"172.16.0.0/12",    // private
		"192.0.0.0/24",     // IETF protocol assignments (Oracle's metadata, 192.0.0.192)
		"192.0.2.0/24",     // documentation
		"192.88.99.0/24",   // 6to4 relay anycast
		"192.168.0.0/16",   // private
		"198.18.0.0/15",    // benchmarking
		"198.51.100.0/24",  // documentation
		"203.0.113.0/24",   // documentation
		"224.0.0.0/4",      // multicast
		"240.0.0.0/4",      // reserved, and the broadcast address
		"168.63.129.16/32", // Azure's host services (WireServer)
		// IPv6.
		"::/96",          // unspecified, loopback (::1) and IPv4-compatible
		"64:ff9b::/96",   // NAT64
		"64:ff9b:1::/48", // local-use NAT64
		"100::/64",       // discard
		"2001::/23",      // IETF protocol assignments, Teredo included
		"2001:db8::/32",  // documentation
		"2002::/16",      // 6to4
		"fc00::/7",       // unique local (AWS's IPv6 metadata, fd00:ec2::254)
		"fe80::/10",      // link-local
		"fec0::/10",      // site-local (deprecated, still routed by some stacks)
		"ff00::/8",       // multicast
	}
	prefixes := make([]netip.Prefix, len(ranges))
	for i, r := range ranges {
		prefixes[i] = netip.MustParsePrefix(r)
	}
	return prefixes
}()

// isPublicAddress: an address outside every range in nonPublicPrefixes.
func isPublicAddress(ip netip.Addr) bool {
	if !ip.IsValid() {
		return false
	}
	ip = ip.Unmap().WithZone("")
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

// refuseNonPublicAddress is the dialer's Control hook: address is the IP and port being
// connected to, after DNS.
func refuseNonPublicAddress(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errAddressRefused
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !isPublicAddress(ip) {
		return errAddressRefused
	}
	return nil
}

// outboundTransportOptions tunes newPublicOnlyTransport.
type outboundTransportOptions struct {
	// connectTimeout bounds the dial and the TLS handshake.
	connectTimeout time.Duration
	// headerTimeout bounds the wait for the answer's headers; 0 leaves it to the
	// request's context.
	headerTimeout time.Duration
	// maxHeaderBytes caps the answer's headers.
	maxHeaderBytes int64
	// allowPrivate skips the address check: development only
	// (PLUGIN_WEBHOOKS_ALLOW_INSECURE), never for embeds.
	allowPrivate bool
	// tls, when set, replaces the default TLS config (tests: a test server's root).
	tls *tls.Config
}

// newPublicOnlyTransport dials public addresses only, with no proxy and no keep-alives.
func newPublicOnlyTransport(opts outboundTransportOptions) *http.Transport {
	dialer := &net.Dialer{Timeout: opts.connectTimeout}
	if !opts.allowPrivate {
		dialer.Control = refuseNonPublicAddress
	}
	tlsConfig := opts.tls
	if tlsConfig == nil {
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		TLSClientConfig:        tlsConfig,
		TLSHandshakeTimeout:    opts.connectTimeout,
		ResponseHeaderTimeout:  opts.headerTimeout,
		MaxResponseHeaderBytes: opts.maxHeaderBytes,
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      false,
	}
}
