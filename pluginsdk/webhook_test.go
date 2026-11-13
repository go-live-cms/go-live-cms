package pluginsdk

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

func TestSignWebhookIsHMACOverTimestampAndBody(t *testing.T) {
	secret, body, ts := "0123456789abcdef-secret", []byte(`{"id":7}`), int64(1731500000)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10) + "." + string(body)))
	if got, want := SignWebhook(secret, ts, body), "v1="+hex.EncodeToString(mac.Sum(nil)); got != want {
		t.Fatalf("SignWebhook = %s, want %s", got, want)
	}
}

func TestVerifyWebhook(t *testing.T) {
	secret, body := "0123456789abcdef-secret", []byte(`{"id":7,"event":"post.published"}`)
	now := time.Unix(1731500000, 0)
	ts := strconv.FormatInt(now.Unix(), 10)
	sig := SignWebhook(secret, now.Unix(), body)

	ok := func(name, timestamp, signature string, body []byte, at time.Time) {
		t.Helper()
		if err := VerifyWebhook(secret, timestamp, signature, body, at, 0); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	refused := func(name, timestamp, signature string, body []byte, at time.Time, want error) {
		t.Helper()
		if err := VerifyWebhook(secret, timestamp, signature, body, at, 0); err != want {
			t.Errorf("%s: got %v, want %v", name, err, want)
		}
	}

	ok("valid", ts, sig, body, now)
	ok("inside the window", ts, sig, body, now.Add(WebhookReplayWindow))
	ok("one of two signatures (rotation)", ts, SignWebhook("another-secret-0000", now.Unix(), body)+", "+sig, body, now)
	refused("body changed", ts, sig, []byte(`{"id":8,"event":"post.published"}`), now, ErrWebhookSignature)
	refused("wrong secret", ts, SignWebhook("wrong-secret-00000", now.Unix(), body), body, now, ErrWebhookSignature)
	refused("timestamp changed", strconv.FormatInt(now.Unix()+1, 10), sig, body, now, ErrWebhookSignature)
	refused("replayed later", ts, sig, body, now.Add(WebhookReplayWindow+time.Second), ErrWebhookTimestamp)
	refused("from the future", ts, sig, body, now.Add(-WebhookReplayWindow-time.Second), ErrWebhookTimestamp)
	refused("no timestamp", "", sig, body, now, ErrWebhookTimestamp)
	refused("another version", ts, "v2="+sig[3:], body, now, ErrWebhookSignature)
	refused("not hex", ts, "v1=zz", body, now, ErrWebhookSignature)
	refused("empty", ts, "", body, now, ErrWebhookSignature)
}
