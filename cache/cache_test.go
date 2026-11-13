package cache

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newMiniredis(t *testing.T) (*miniredis.Miniredis, *Redis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	return mr, NewRedisFromClient(client)
}

func TestNewWithoutURLIsNoop(t *testing.T) {
	for _, url := range []string{"", "   "} {
		c, err := New(url)
		require.NoError(t, err)
		require.IsType(t, Noop{}, c)
		require.False(t, c.Enabled())
	}
}

func TestNewParsesURL(t *testing.T) {
	c, err := New("redis://valkey:6379/0")
	require.NoError(t, err)
	require.True(t, c.Enabled())
	require.NoError(t, c.Close())

	c, err = New("rediss://user:pass@cache.example.com:6380/2")
	require.NoError(t, err)
	require.NoError(t, c.Close())
}

func TestNewRejectsBadURLWithoutEchoingIt(t *testing.T) {
	for _, url := range []string{
		"http://valkey:6379", "redis://:s3cret@valkey:notaport", "valkey:6379",
		// No scheme: url.Parse quotes the raw value in its error.
		":s3cret@valkey:6379", "user:s3cret@valkey:6379", "s3cret valkey",
	} {
		_, err := New(url)
		require.Error(t, err, url)
		require.NotContains(t, err.Error(), "s3cret")
		require.Contains(t, err.Error(), "REDIS_URL")
	}
}

func TestNoop(t *testing.T) {
	ctx := context.Background()
	var c Cache = Noop{}
	require.NoError(t, c.Set(ctx, "k", []byte("v"), time.Minute))
	_, err := c.Get(ctx, "k")
	require.ErrorIs(t, err, ErrMiss)
	ok, err := c.SetNX(ctx, "k", []byte("v"), 0)
	require.NoError(t, err)
	require.False(t, ok)
	require.NoError(t, c.Delete(ctx, "k"))
	require.NoError(t, c.Ping(ctx))
	require.NoError(t, c.Close())
}

func TestRedisGetSetDelete(t *testing.T) {
	ctx := context.Background()
	mr, c := newMiniredis(t)

	_, err := c.Get(ctx, "a")
	require.ErrorIs(t, err, ErrMiss)

	require.NoError(t, c.Set(ctx, "a", []byte("1"), time.Minute))
	got, err := c.Get(ctx, "a")
	require.NoError(t, err)
	require.Equal(t, "1", string(got))
	require.Equal(t, time.Minute, mr.TTL("a"))

	ok, err := c.SetNX(ctx, "a", []byte("2"), 0)
	require.NoError(t, err)
	require.False(t, ok)
	ok, err = c.SetNX(ctx, "b", []byte("2"), 0)
	require.NoError(t, err)
	require.True(t, ok)
	require.Zero(t, mr.TTL("b"), "ttl 0 = no expiry")

	require.NoError(t, c.Delete(ctx, "a", "b", "missing"))
	require.NoError(t, c.Delete(ctx))
	require.False(t, mr.Exists("a"))
	require.False(t, mr.Exists("b"))

	mr.FastForward(2 * time.Minute)
	require.NoError(t, c.Ping(ctx))
}

func TestRedisErrorsAreNotMisses(t *testing.T) {
	ctx := context.Background()
	mr, c := newMiniredis(t)
	mr.Close()
	_, err := c.Get(ctx, "a")
	require.Error(t, err)
	require.False(t, errors.Is(err, ErrMiss), "a down cache is an error, not a miss")
}

func TestNamespaceKeysAndPurge(t *testing.T) {
	ctx := context.Background()
	mr, c := newMiniredis(t)
	ns := NewNamespace(c, "public")

	k1, err := ns.Key(ctx, "x")
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(k1, "public:"))
	require.True(t, strings.HasSuffix(k1, ":x"))
	require.Zero(t, mr.TTL("public:gen"), "the generation never expires")

	again, err := ns.Key(ctx, "x")
	require.NoError(t, err)
	require.Equal(t, k1, again, "stable until a purge")

	require.NoError(t, ns.Purge(ctx))
	k2, err := ns.Key(ctx, "x")
	require.NoError(t, err)
	require.NotEqual(t, k1, k2, "a purge moves every key")

	// The generation evicted (or Valkey restarted empty): a new one, never the old.
	mr.Del("public:gen")
	k3, err := ns.Key(ctx, "x")
	require.NoError(t, err)
	require.NotEqual(t, k2, k3)
	require.NotEqual(t, k1, k3)
}

func TestNamespaceUsesAConcurrentlyCreatedGeneration(t *testing.T) {
	ctx := context.Background()
	_, c := newMiniredis(t)
	race := &setNXLoses{Cache: c, other: "theirs"}
	ns := NewNamespace(race, "public")
	key, err := ns.Key(ctx, "x")
	require.NoError(t, err)
	require.Equal(t, "public:theirs:x", key)
}

// setNXLoses simulates another replica creating the generation between our Get and SetNX.
type setNXLoses struct {
	Cache
	other string
}

func (s *setNXLoses) SetNX(ctx context.Context, key string, _ []byte, ttl time.Duration) (bool, error) {
	_, err := s.Cache.SetNX(ctx, key, []byte(s.other), ttl)
	return false, err
}

func TestNamespaceErrors(t *testing.T) {
	ctx := context.Background()
	mr, c := newMiniredis(t)
	ns := NewNamespace(c, "public")
	mr.Close()
	_, err := ns.Key(ctx, "x")
	require.Error(t, err)
	require.Error(t, ns.Purge(ctx))
}

func TestNamespaceOnNoopHasNoKeys(t *testing.T) {
	ctx := context.Background()
	ns := NewNamespace(Noop{}, "public")
	// Nothing can be stored, so there is no generation to key by: callers read the
	// source of truth (they check Enabled first anyway).
	_, err := ns.Key(ctx, "x")
	require.ErrorIs(t, err, ErrMiss)
	require.NoError(t, ns.Purge(ctx))
}
