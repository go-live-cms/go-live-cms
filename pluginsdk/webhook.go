package pluginsdk

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Webhooks (#460, docs/design/plugin-system.md section 7.9): a plugin without Go code
// receives its events as signed HTTP POSTs. This is the signature both sides compute; a
// receiver written in Go can call VerifyWebhook, and one in another language follows
// the same steps.
//
// Every delivery carries:
//
//	GoLive-Event-Id:  the event's id, the same on every retry: the idempotency key
//	GoLive-Event:     the event name (post.published, ...)
//	GoLive-Timestamp: when this attempt was signed, Unix seconds
//	GoLive-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>
//
// The body is the JSON of WebhookPayload. A receiver verifies the signature over the raw
// bytes it received (never re-encoded JSON), refuses a timestamp outside its replay
// window (WebhookReplayWindow), and ignores an event id it has already handled.
const (
	WebhookHeaderEventID   = "GoLive-Event-Id"
	WebhookHeaderEvent     = "GoLive-Event"
	WebhookHeaderTimestamp = "GoLive-Timestamp"
	WebhookHeaderSignature = "GoLive-Signature"

	// WebhookSignatureVersion prefixes each signature, so the scheme can change
	// without a receiver mistaking one for another.
	WebhookSignatureVersion = "v1"

	// WebhookReplayWindow is how far a timestamp may be from the receiver's clock.
	// Retries are signed again when they're sent, so a genuine delivery is always fresh.
	WebhookReplayWindow = 5 * time.Minute

	// WebhookSecretMinLength is the shortest signing secret GoLive signs with.
	WebhookSecretMinLength = 16
)

// WebhookPayload is a delivery's body: the Event, as JSON.
type WebhookPayload struct {
	// ID is Event.ID: the idempotency key.
	ID    int64  `json:"id"`
	Event string `json:"event"`
	// Plugin is the plugin's id (its plugin.json id).
	Plugin string `json:"plugin"`
	PostID int64  `json:"post_id"`
	// ActorID is null when the event credits no member.
	ActorID    *int64         `json:"actor_id"`
	Data       map[string]any `json:"data"`
	OccurredAt time.Time      `json:"occurred_at"`
}

// SignWebhook returns the GoLive-Signature value for body signed at timestamp (Unix
// seconds).
func SignWebhook(secret string, timestamp int64, body []byte) string {
	return WebhookSignatureVersion + "=" + hex.EncodeToString(webhookMAC(secret, timestamp, body))
}

func webhookMAC(secret string, timestamp int64, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	return mac.Sum(nil)
}

// Errors VerifyWebhook returns.
var (
	ErrWebhookTimestamp = errors.New("pluginsdk: webhook timestamp missing or outside the replay window")
	ErrWebhookSignature = errors.New("pluginsdk: webhook signature does not match")
)

// VerifyWebhook checks a delivery: the timestamp header is within window of now, and
// one of the signature header's v1 values (comma-separated, so a sender may sign with
// two secrets while one is rotated) is the HMAC of the raw body under secret. window 0
// means WebhookReplayWindow.
func VerifyWebhook(secret, timestampHeader, signatureHeader string, body []byte, now time.Time, window time.Duration) error {
	if window <= 0 {
		window = WebhookReplayWindow
	}
	timestamp, err := strconv.ParseInt(strings.TrimSpace(timestampHeader), 10, 64)
	if err != nil {
		return ErrWebhookTimestamp
	}
	if skew := now.Sub(time.Unix(timestamp, 0)); skew > window || skew < -window {
		return ErrWebhookTimestamp
	}
	want := webhookMAC(secret, timestamp, body)
	for _, part := range strings.Split(signatureHeader, ",") {
		version, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || version != WebhookSignatureVersion {
			continue
		}
		got, err := hex.DecodeString(value)
		if err == nil && hmac.Equal(got, want) {
			return nil
		}
	}
	return ErrWebhookSignature
}
