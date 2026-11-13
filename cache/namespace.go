package cache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
)

// Namespace is a set of keys that are invalidated together, in one operation.
//
// Every key is prefixed with the namespace's current generation, a random token stored
// under "<name>:gen" without expiry. Purge stores a new token: every key written under
// the old one becomes unreachable at once (no SCAN, no list of keys to delete) and
// expires on its own TTL. Valkey's eviction policy may also drop the token; the next
// read then makes a new one, which is the same as a purge.
//
// Readers must take the generation (Key) **before** reading the source of truth. A
// reader that took generation A, read Postgres before a write committed, and stores its
// result after the writer's Purge has moved on to B, stores it under A, where nobody
// looks any more. That's what makes a purge after commit enough without locks.
type Namespace struct {
	cache  Cache
	name   string
	genKey string
}

// NewNamespace returns the namespace called name (a key prefix such as "public").
func NewNamespace(c Cache, name string) *Namespace {
	return &Namespace{cache: c, name: name, genKey: name + ":gen"}
}

// Key returns the full key for suffix under the current generation:
// "<name>:<generation>:<suffix>". A missing generation is created (SETNX, so replicas
// racing to create it agree on one). An error means the cache is unusable for this read;
// the caller reads the source of truth and stores nothing.
func (n *Namespace) Key(ctx context.Context, suffix string) (string, error) {
	gen, err := n.generation(ctx)
	if err != nil {
		return "", err
	}
	return n.name + ":" + gen + ":" + suffix, nil
}

func (n *Namespace) generation(ctx context.Context) (string, error) {
	gen, err := n.cache.Get(ctx, n.genKey)
	if err == nil && len(gen) > 0 {
		return string(gen), nil
	}
	if err != nil && !errors.Is(err, ErrMiss) {
		return "", err
	}
	fresh := newGeneration()
	created, err := n.cache.SetNX(ctx, n.genKey, []byte(fresh), 0)
	if err != nil {
		return "", err
	}
	if created {
		return fresh, nil
	}
	// Another reader created it first: use theirs.
	gen, err = n.cache.Get(ctx, n.genKey)
	if err != nil {
		return "", err
	}
	return string(gen), nil
}

// Purge invalidates every key of the namespace by moving it to a new generation.
func (n *Namespace) Purge(ctx context.Context) error {
	return n.cache.Set(ctx, n.genKey, []byte(newGeneration()), 0)
}

// newGeneration is 64 random bits as hex: never reused, so an old generation's keys can't
// come back after the token is evicted or Valkey restarts empty.
func newGeneration() string {
	var b [8]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails (Go 1.24)
	return hex.EncodeToString(b[:])
}
