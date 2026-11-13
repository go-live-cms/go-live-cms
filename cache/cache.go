// Package cache is GoLive's cache client (#185): a Cache interface with a Valkey/Redis
// implementation (go-redis) and a no-op one.
//
// REDIS_URL is optional. Unset, New returns the no-op cache: every Get misses and every
// write succeeds without storing anything, so tests and plain dev runs need nothing new
// and the API behaves exactly as it did without a cache. The cache is never the source of
// truth: Postgres is, and every caller treats an error here as a miss.
package cache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrMiss is what Get returns for a key that isn't stored (or expired, or was evicted).
var ErrMiss = errors.New("cache: miss")

// Cache is a byte-value key store with expiry.
type Cache interface {
	// Get returns the value stored under key, or ErrMiss.
	Get(ctx context.Context, key string) ([]byte, error)
	// Set stores value under key for ttl; ttl 0 means no expiry.
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// SetNX stores value under key only if the key is absent, and reports whether it did.
	SetNX(ctx context.Context, key string, value []byte, ttl time.Duration) (bool, error)
	// Delete removes keys; absent keys are not an error.
	Delete(ctx context.Context, keys ...string) error
	// Enabled is false for the no-op cache, so callers can skip work that only
	// makes sense when something is stored.
	Enabled() bool
	// Ping checks the connection (nil for the no-op cache).
	Ping(ctx context.Context) error
	// Close releases the connection pool.
	Close() error
}

// Timeouts for the Valkey client. A cache that answers slowly must not slow the site
// down: past these, an operation fails and the caller reads Postgres instead.
const (
	dialTimeout   = 500 * time.Millisecond
	dialerRetries = 1
	ioTimeout     = 250 * time.Millisecond
	poolTimeout   = 250 * time.Millisecond
	poolMinIdle   = 2
	maxRetries    = 1
	clientName    = "golive"
)

// silenceClientLog stops go-redis printing its own lines (a dial failure per attempt,
// unstructured, on stderr). Callers log cache failures themselves, throttled.
var silenceClientLog sync.Once

type discardLogger struct{}

func (discardLogger) Printf(context.Context, string, ...interface{}) {}

// New returns the cache for redisURL: the no-op cache when it is empty, else a
// Valkey/Redis client (redis:// or rediss:// URL, e.g. redis://valkey:6379/0). It does
// not connect: a Valkey that is down at startup only means misses until it is back.
// An unparsable URL is an error (a typo must not silently turn the cache off).
func New(redisURL string) (Cache, error) {
	redisURL = strings.TrimSpace(redisURL)
	if redisURL == "" {
		return Noop{}, nil
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		// Never echo the URL: it may carry a password.
		return nil, fmt.Errorf("invalid REDIS_URL: want redis://[user:password@]host:port[/db] or rediss://... (%s)", redactURLError(err))
	}
	opts.DialTimeout = dialTimeout
	opts.DialerRetries = dialerRetries
	opts.ReadTimeout = ioTimeout
	opts.WriteTimeout = ioTimeout
	opts.PoolTimeout = poolTimeout
	opts.MinIdleConns = poolMinIdle
	opts.MaxRetries = maxRetries
	opts.ClientName = clientName
	silenceClientLog.Do(func() { redis.SetLogger(discardLogger{}) })
	return &Redis{client: redis.NewClient(opts)}, nil
}

// redactURLError keeps go-redis's reason without any part of the URL.
func redactURLError(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, "://"); i >= 0 {
		return "unparsable URL"
	}
	return msg
}

// Redis is the Valkey/Redis implementation.
type Redis struct {
	client *redis.Client
}

// NewRedisFromClient wraps an existing go-redis client (tests point one at miniredis).
func NewRedisFromClient(client *redis.Client) *Redis {
	silenceClientLog.Do(func() { redis.SetLogger(discardLogger{}) })
	return &Redis{client: client}
}

func (r *Redis) Get(ctx context.Context, key string) ([]byte, error) {
	value, err := r.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrMiss
	}
	return value, err
}

func (r *Redis) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *Redis) SetNX(ctx context.Context, key string, value []byte, ttl time.Duration) (bool, error) {
	return r.client.SetNX(ctx, key, value, ttl).Result()
}

func (r *Redis) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return r.client.Del(ctx, keys...).Err()
}

func (r *Redis) Enabled() bool { return true }

func (r *Redis) Ping(ctx context.Context) error { return r.client.Ping(ctx).Err() }

func (r *Redis) Close() error { return r.client.Close() }

// Noop stores nothing: every Get misses, every write succeeds. The default when
// REDIS_URL is unset, and what handler tests run with.
type Noop struct{}

func (Noop) Get(context.Context, string) ([]byte, error) { return nil, ErrMiss }

func (Noop) Set(context.Context, string, []byte, time.Duration) error { return nil }

func (Noop) SetNX(context.Context, string, []byte, time.Duration) (bool, error) { return false, nil }

func (Noop) Delete(context.Context, ...string) error { return nil }

func (Noop) Enabled() bool { return false }

func (Noop) Ping(context.Context) error { return nil }

func (Noop) Close() error { return nil }
