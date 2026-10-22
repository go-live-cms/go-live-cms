// Package api — minimal HTTP metrics (#142).
//
// httpMetrics counts the public router's requests and their latency, and
// serves them in the Prometheus text format at GET /metrics on the INTERNAL
// listener (internal_routes.go), which is never published. It is hand-rolled
// to avoid a client-library dependency for two series.
//
// Labels are bounded so a client can't blow up the series count: the route is
// the matched template (or "(unmatched)"), unknown methods become "OTHER", and
// the status is the numeric code.
package api

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// latencyBuckets are the histogram upper bounds, in seconds.
var latencyBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type metricKey struct {
	method string
	route  string
	status int
}

type metricSeries struct {
	count   uint64
	sum     float64
	buckets []uint64 // cumulative counts, one per latencyBuckets entry
}

type httpMetrics struct {
	mu     sync.Mutex
	series map[metricKey]*metricSeries
}

func newHTTPMetrics() *httpMetrics {
	return &httpMetrics{series: make(map[metricKey]*metricSeries)}
}

var knownMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, http.MethodOptions: true,
}

func metricMethod(method string) string {
	if knownMethods[method] {
		return method
	}
	return "OTHER"
}

func (m *httpMetrics) observe(method, route string, status int, latency time.Duration) {
	key := metricKey{method: metricMethod(method), route: route, status: status}
	seconds := latency.Seconds()

	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.series[key]
	if s == nil {
		s = &metricSeries{buckets: make([]uint64, len(latencyBuckets))}
		m.series[key] = s
	}
	s.count++
	s.sum += seconds
	for i, bound := range latencyBuckets {
		if seconds <= bound {
			s.buckets[i]++
		}
	}
}

// escapeLabel escapes a Prometheus label value.
func escapeLabel(v string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(v)
}

// render writes the metrics in the Prometheus text exposition format, sorted
// so the output is stable.
func (m *httpMetrics) render() string {
	m.mu.Lock()
	keys := make([]metricKey, 0, len(m.series))
	snapshot := make(map[metricKey]metricSeries, len(m.series))
	for k, s := range m.series {
		keys = append(keys, k)
		snapshot[k] = metricSeries{count: s.count, sum: s.sum, buckets: append([]uint64(nil), s.buckets...)}
	}
	m.mu.Unlock()

	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.route != b.route {
			return a.route < b.route
		}
		if a.method != b.method {
			return a.method < b.method
		}
		return a.status < b.status
	})

	var sb strings.Builder
	sb.WriteString("# HELP golive_http_requests_total HTTP requests handled by the public API.\n")
	sb.WriteString("# TYPE golive_http_requests_total counter\n")
	for _, k := range keys {
		fmt.Fprintf(&sb, "golive_http_requests_total{%s} %d\n", k.labels(), snapshot[k].count)
	}
	sb.WriteString("# HELP golive_http_request_duration_seconds Public API request latency.\n")
	sb.WriteString("# TYPE golive_http_request_duration_seconds histogram\n")
	for _, k := range keys {
		s := snapshot[k]
		labels := k.labels()
		for i, bound := range latencyBuckets {
			fmt.Fprintf(&sb, "golive_http_request_duration_seconds_bucket{%s,le=\"%g\"} %d\n", labels, bound, s.buckets[i])
		}
		fmt.Fprintf(&sb, "golive_http_request_duration_seconds_bucket{%s,le=\"+Inf\"} %d\n", labels, s.count)
		fmt.Fprintf(&sb, "golive_http_request_duration_seconds_sum{%s} %g\n", labels, s.sum)
		fmt.Fprintf(&sb, "golive_http_request_duration_seconds_count{%s} %d\n", labels, s.count)
	}
	return sb.String()
}

func (k metricKey) labels() string {
	return fmt.Sprintf(`method="%s",route="%s",status="%d"`, escapeLabel(k.method), escapeLabel(k.route), k.status)
}

// handler serves GET /metrics (internal listener only).
func (m *httpMetrics) handler(c *gin.Context) {
	c.Data(http.StatusOK, "text/plain; version=0.0.4; charset=utf-8", []byte(m.render()))
}
