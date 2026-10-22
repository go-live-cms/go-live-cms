// ratelimit implements per-client request rate limiting (#190, #156).
//
// # Tiers
//
//   - General: every /api/v1 and /public request, per client
//     (RATE_LIMIT_GENERAL_PER_MINUTE). IPs in RATE_LIMIT_EXEMPT_CIDRS skip it.
//   - Login: POST /auth/login, per client (RATE_LIMIT_LOGIN_IP_PER_MINUTE) and,
//     checked in loginUser once the body is bound, per client and username
//     (RATE_LIMIT_LOGIN_PER_MINUTE). The pair limit holds brute force on one
//     account down, while one client's bad guesses can't lock out everyone
//     else behind the same IP. The looser per-client limit caps spraying
//     across usernames.
//   - Register: POST /auth/register, per client (RATE_LIMIT_LOGIN_PER_MINUTE).
//   - Refresh: POST /auth/refresh, per client (RATE_LIMIT_REFRESH_PER_MINUTE).
//     The admin client keeps the user signed in on a 429 and retries later.
//   - Password change: a self PUT /users/:id with a password, per user and
//     client (RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE), checked inside updateUser
//     because only the body says whether a password is being changed. Keying
//     by user alone would let whoever stole a token lock the owner out of the
//     password change that revokes it.
//
// The internal listener (/internal/*) is not limited: only the collab WS server
// can reach it, it calls once per connection for every editor, and its
// shared secret can't be guessed in any useful number of requests.
//
// # Client identity
//
// The client is gin's ClientIP, which reads X-Forwarded-For / X-Real-IP only
// when the TCP peer is in TRUSTED_PROXIES (none by default). Otherwise anyone
// could send a fresh X-Forwarded-For per request and never hit a limit. IPv6
// clients are keyed by their /64 (clientKey), because one host or subscriber
// usually holds a whole /64 and could otherwise use a new address per request.
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
	"hash/maphash"
	"log/slog"
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

const (
	// rateLimitShards splits each store's keys across independently locked
	// maps, so requests (and idle sweeps) for different keys rarely contend.
	rateLimitShards = 32
	// rateLimitMaxKeys bounds the keys one store tracks (~100 bytes each plus
	// the key), so a flood of distinct clients can't grow memory without bound.
	rateLimitMaxKeys = 100_000
)

// memoryRateLimitStore is an in-process token bucket per key
// (golang.org/x/time/rate). Each bucket holds perMinute tokens and refills
// perMinute tokens a minute, so a full bucket refills in exactly one minute.
// A bucket idle that long is therefore identical to a new one, and is evicted.
//
// When a shard is full of buckets that are all still in use, the least
// recently used one is evicted to make room: that client merely starts again
// with a full allowance, which beats failing every new client.
type memoryRateLimitStore struct {
	limit rate.Limit
	burst int
	// idleTTL is how long a bucket may go unused before it is evicted. It is
	// at least the time a bucket takes to refill completely.
	idleTTL         time.Duration
	maxKeysPerShard int
	now             func() time.Time

	seed   maphash.Seed
	shards []*rateLimitShard
}

type rateLimitShard struct {
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
	return newShardedMemoryRateLimitStore(perMinute, rateLimitShards, rateLimitMaxKeys)
}

// newShardedMemoryRateLimitStore is newMemoryRateLimitStore with explicit
// sharding and capacity (tests use one small shard).
func newShardedMemoryRateLimitStore(perMinute, shards, maxKeys int) *memoryRateLimitStore {
	s := &memoryRateLimitStore{
		limit:           rate.Limit(float64(perMinute) / 60),
		burst:           perMinute,
		idleTTL:         time.Minute,
		maxKeysPerShard: max(1, maxKeys/shards),
		now:             time.Now,
		seed:            maphash.MakeSeed(),
		shards:          make([]*rateLimitShard, shards),
	}
	for i := range s.shards {
		s.shards[i] = &rateLimitShard{entries: make(map[string]*rateLimitEntry)}
	}
	return s
}

func (s *memoryRateLimitStore) shard(key string) *rateLimitShard {
	return s.shards[maphash.String(s.seed, key)%uint64(len(s.shards))]
}

// Take implements RateLimitStore. It never returns an error.
func (s *memoryRateLimitStore) Take(_ context.Context, key string) (bool, time.Duration, error) {
	now := s.now()
	sh := s.shard(key)

	sh.mu.Lock()
	defer sh.mu.Unlock()

	// Sweep at most once per idleTTL so a request costs O(1) amortized.
	if now.Sub(sh.lastSweep) >= s.idleTTL {
		sh.evictIdle(now, s.idleTTL)
		sh.lastSweep = now
	}

	e, ok := sh.entries[key]
	if !ok {
		if len(sh.entries) >= s.maxKeysPerShard {
			sh.evictIdle(now, s.idleTTL)
			if len(sh.entries) >= s.maxKeysPerShard {
				sh.evictLeastRecentlySeen()
			}
		}
		e = &rateLimitEntry{limiter: rate.NewLimiter(s.limit, s.burst)}
		sh.entries[key] = e
	}
	e.lastSeen = now

	r := e.limiter.ReserveN(now, 1)
	if delay := r.DelayFrom(now); delay > 0 {
		r.CancelAt(now) // a rejected request must not use up future tokens
		return false, delay, nil
	}
	return true, 0, nil
}

// evictIdle drops buckets unused for ttl. sh.mu must be held.
func (sh *rateLimitShard) evictIdle(now time.Time, ttl time.Duration) {
	for key, e := range sh.entries {
		if now.Sub(e.lastSeen) >= ttl {
			delete(sh.entries, key)
		}
	}
}

// evictLeastRecentlySeen drops the bucket used longest ago. Only reached when
// the shard is full of active buckets. sh.mu must be held.
func (sh *rateLimitShard) evictLeastRecentlySeen() {
	var oldestKey string
	var oldest time.Time
	for key, e := range sh.entries {
		if oldestKey == "" || e.lastSeen.Before(oldest) {
			oldestKey, oldest = key, e.lastSeen
		}
	}
	delete(sh.entries, oldestKey)
}

// len reports how many keys are tracked (tests).
func (s *memoryRateLimitStore) len() int {
	n := 0
	for _, sh := range s.shards {
		sh.mu.Lock()
		n += len(sh.entries)
		sh.mu.Unlock()
	}
	return n
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
		slog.Warn("rate limit store error, allowing request", requestIDKey, requestIDFromContext(c), "limit", l.name, "error", err)
		return true
	}
	if !ok {
		abortRateLimited(c, retryAfter)
		return false
	}
	return true
}

// perIP returns middleware limiting each client (clientKey). exempt client
// IPs skip it.
func (l *rateLimiter) perIP(exempt ...netip.Prefix) gin.HandlerFunc {
	return func(c *gin.Context) {
		if l == nil {
			c.Next()
			return
		}
		ip := c.ClientIP()
		if ipInPrefixes(ip, exempt) {
			c.Next()
			return
		}
		if !l.allow(c, clientKey(ip)) {
			return
		}
		c.Next()
	}
}

// clientKey is the rate-limit identity of a client IP: the address itself for
// IPv4 (including IPv4-mapped IPv6), and the /64 for IPv6, which one host or
// subscriber usually holds in full. Unparsable input is returned unchanged.
func clientKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.WithZone("").Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
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
	general *rateLimiter
	// loginIP limits each client's login attempts across usernames; login
	// limits each client and username pair.
	loginIP        *rateLimiter
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
		loginIP:        newRateLimiter("login-ip", config.RateLimitLoginIPPerMinute),
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
		if err != nil || addr.Zone() != "" {
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
