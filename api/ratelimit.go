// ratelimit implements per-client request rate limiting (#190, #156).
//
// # Tiers
//
//   - General: every /api/v1 and /public request, per client IP
//     (RATE_LIMIT_GENERAL_PER_MINUTE). IPs in RATE_LIMIT_EXEMPT_CIDRS skip it.
//   - Login and register: POST /auth/login, POST /auth/register, per client IP,
//     each with its own allowance (RATE_LIMIT_LOGIN_PER_MINUTE).
//   - Refresh: POST /auth/refresh, per client IP (RATE_LIMIT_REFRESH_PER_MINUTE).
//   - Password change: a self PUT /users/:id with a password, per user
//     (RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE), checked inside updateUser
//     because only the body says whether a password is being changed.
//
// The internal listener (/internal/*) is not limited: only the collab WS server
// can reach it, it calls once per connection for every editor, and its
// shared secret can't be guessed in any useful number of requests.
//
// # Client IP
//
// Keys use gin's ClientIP, which reads X-Forwarded-For / X-Real-IP only when
// the TCP peer is in TRUSTED_PROXIES (none by default). Otherwise anyone could
// send a fresh X-Forwarded-For per request and never hit a limit.
//
// # Storage
//
// Counters live in memory (memoryRateLimitStore), so limits are per API
// process. RateLimitStore is the seam for a shared Redis/Valkey store (#185)
// once there is more than one instance.
package api

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/util"
	"golang.org/x/time/rate"
)

// RateLimitStore holds the request allowance for each key. One store serves
// one limit; keys are already prefixed with the limiter's name.
type RateLimitStore interface {
	// Take consumes one request from key's allowance. When none is left it
	// returns allowed=false and how long until the next request would be
	// allowed, and consumes nothing.
	Take(ctx context.Context, key string) (allowed bool, retryAfter time.Duration, err error)
}

// memoryRateLimitStore is an in-process token bucket per key
// (golang.org/x/time/rate). Each bucket holds perMinute tokens and refills
// perMinute tokens a minute, so a full bucket refills in exactly one minute.
// A bucket idle that long is therefore identical to a new one, and is evicted.
type memoryRateLimitStore struct {
	limit rate.Limit
	burst int
	// idleTTL is how long a bucket may go unused before it is evicted. It is
	// at least the time a bucket takes to refill completely.
	idleTTL time.Duration
	now     func() time.Time

	mu        sync.Mutex
	entries   map[string]*rateLimitEntry
	lastSweep time.Time
}

type rateLimitEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// newMemoryRateLimitStore returns a store allowing perMinute requests a minute
// per key (perMinute must be > 0).
func newMemoryRateLimitStore(perMinute int) *memoryRateLimitStore {
	return &memoryRateLimitStore{
		limit:   rate.Limit(float64(perMinute) / 60),
		burst:   perMinute,
		idleTTL: time.Minute,
		now:     time.Now,
		entries: make(map[string]*rateLimitEntry),
	}
}

// Take implements RateLimitStore. It never returns an error.
func (s *memoryRateLimitStore) Take(_ context.Context, key string) (bool, time.Duration, error) {
	now := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Sweep at most once per idleTTL so a request costs O(1) amortized.
	if now.Sub(s.lastSweep) >= s.idleTTL {
		s.evictIdleLocked(now)
		s.lastSweep = now
	}

	e, ok := s.entries[key]
	if !ok {
		e = &rateLimitEntry{limiter: rate.NewLimiter(s.limit, s.burst)}
		s.entries[key] = e
	}
	e.lastSeen = now

	r := e.limiter.ReserveN(now, 1)
	if delay := r.DelayFrom(now); delay > 0 {
		r.CancelAt(now) // a rejected request must not use up future tokens
		return false, delay, nil
	}
	return true, 0, nil
}

// evictIdleLocked drops buckets unused for idleTTL. s.mu must be held.
func (s *memoryRateLimitStore) evictIdleLocked(now time.Time) {
	for key, e := range s.entries {
		if now.Sub(e.lastSeen) >= s.idleTTL {
			delete(s.entries, key)
		}
	}
}

// len reports how many keys are tracked (tests).
func (s *memoryRateLimitStore) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// rateLimiter applies one limit. A nil *rateLimiter is a disabled limit:
// every method lets the request through.
type rateLimiter struct {
	name  string // key prefix, so limiters can share a store
	store RateLimitStore
}

// newRateLimiter returns an in-memory limiter of perMinute requests a minute
// per key, or nil (disabled) when perMinute is 0.
func newRateLimiter(name string, perMinute int) *rateLimiter {
	if perMinute <= 0 {
		return nil
	}
	return &rateLimiter{name: name, store: newMemoryRateLimitStore(perMinute)}
}

// allow consumes one request for key. If the limit is exhausted it aborts with
// 429 and returns false; the caller must then return. Store errors fail open
// (logged): a broken limiter must not take the API down with it.
func (l *rateLimiter) allow(c *gin.Context, key string) bool {
	if l == nil {
		return true
	}
	ok, retryAfter, err := l.store.Take(c.Request.Context(), l.name+":"+key)
	if err != nil {
		log.Printf("rate limit %s: store error, allowing request: %v", l.name, err)
		return true
	}
	if !ok {
		abortRateLimited(c, retryAfter)
		return false
	}
	return true
}

// perIP returns middleware limiting each client IP. exempt client IPs skip it.
func (l *rateLimiter) perIP(exempt ...netip.Prefix) gin.HandlerFunc {
	return func(c *gin.Context) {
		if l == nil || ipInPrefixes(c.ClientIP(), exempt) {
			c.Next()
			return
		}
		if !l.allow(c, c.ClientIP()) {
			return
		}
		c.Next()
	}
}

// abortRateLimited responds 429 with Retry-After (whole seconds, at least 1)
// and the API's usual {"error": ...} body.
func abortRateLimited(c *gin.Context, retryAfter time.Duration) {
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	c.Header("Retry-After", fmt.Sprint(seconds))
	c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many requests, try again later"})
}

// rateLimits holds the server's limiters (nil fields are disabled).
type rateLimits struct {
	general        *rateLimiter
	login          *rateLimiter
	register       *rateLimiter
	refresh        *rateLimiter
	passwordChange *rateLimiter
	// generalExempt client IPs skip the general limit only.
	generalExempt []netip.Prefix
}

// newRateLimits builds the limiters from config. It fails on an unparsable
// RATE_LIMIT_EXEMPT_CIDRS entry.
func newRateLimits(config util.Config) (rateLimits, error) {
	exempt, err := parsePrefixes(config.RateLimitExemptList())
	if err != nil {
		return rateLimits{}, fmt.Errorf("invalid RATE_LIMIT_EXEMPT_CIDRS: %w", err)
	}
	return rateLimits{
		general:        newRateLimiter("general", config.RateLimitGeneralPerMinute),
		login:          newRateLimiter("login", config.RateLimitLoginPerMinute),
		register:       newRateLimiter("register", config.RateLimitLoginPerMinute),
		refresh:        newRateLimiter("refresh", config.RateLimitRefreshPerMinute),
		passwordChange: newRateLimiter("password", config.RateLimitPasswordChangePerMinute),
		generalExempt:  exempt,
	}, nil
}

// parsePrefixes parses CIDRs or bare IPs (a single-address prefix).
func parsePrefixes(values []string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, v := range values {
		if p, err := netip.ParsePrefix(v); err == nil {
			prefixes = append(prefixes, p.Masked())
			continue
		}
		addr, err := netip.ParseAddr(v)
		if err != nil {
			return nil, fmt.Errorf("%q is not an IP or CIDR", v)
		}
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return prefixes, nil
}

// ipInPrefixes reports whether ip is inside any of prefixes. IPv4-mapped IPv6
// addresses are matched as IPv4.
func ipInPrefixes(ip string, prefixes []netip.Prefix) bool {
	if len(prefixes) == 0 {
		return false
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, p := range prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
