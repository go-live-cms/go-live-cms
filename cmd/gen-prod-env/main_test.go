package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/go-live-cms/go-live-cms/token"
	"github.com/stretchr/testify/require"
)

func parseEnv(t *testing.T, out string) map[string]string {
	t.Helper()
	env := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		require.True(t, ok, "line %q", line)
		env[k] = v
	}
	return env
}

func TestWriteEnvProducesUsableKeys(t *testing.T) {
	var buf bytes.Buffer
	require.NoError(t, writeEnv(&buf, rand.Reader, "cms.example.com"))
	env := parseEnv(t, buf.String())

	require.Equal(t, "cms.example.com", env["SITE_ADDRESS"])
	hexOf := func(n int) *regexp.Regexp { return regexp.MustCompile(fmt.Sprintf(`^[0-9a-f]{%d}$`, n)) }
	require.Regexp(t, hexOf(64), env["PASETO_V4_PUBLIC_KEY_HEX"])
	require.Regexp(t, hexOf(128), env["PASETO_V4_PRIVATE_KEY_HEX"])
	for _, k := range []string{"PASETO_V4_LOCAL_KEY_HEX", "POSTGRES_PASSWORD", "ROLE_LOOKUP_SECRET", "COLLAB_INTERNAL_SECRET"} {
		require.Regexp(t, hexOf(64), env[k], k)
	}
	// The private key embeds the public one, and the API accepts the set.
	require.True(t, strings.HasSuffix(env["PASETO_V4_PRIVATE_KEY_HEX"], env["PASETO_V4_PUBLIC_KEY_HEX"]))
	_, err := token.NewPasetoV4Maker(env["PASETO_V4_PRIVATE_KEY_HEX"], env["PASETO_V4_PUBLIC_KEY_HEX"],
		env["PASETO_V4_LOCAL_KEY_HEX"], "golive.auth", "golive.admin", "k4.pub.test", "k4.loc.test")
	require.NoError(t, err)

	// Every secret is fresh.
	var again bytes.Buffer
	require.NoError(t, writeEnv(&again, rand.Reader, "cms.example.com"))
	other := parseEnv(t, again.String())
	for k, v := range env {
		if k != "SITE_ADDRESS" {
			require.NotEqual(t, v, other[k], k)
		}
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

func TestWriteEnvFailsWithoutRandomness(t *testing.T) {
	var buf bytes.Buffer
	require.Error(t, writeEnv(&buf, failingReader{}, "localhost"))
	require.Empty(t, buf.String())
}
