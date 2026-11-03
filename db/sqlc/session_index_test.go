package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #160: BlockAllSessionsForUser (logout everywhere, password change/reset,
// refresh reuse) is served by the partial index on the user's live sessions
// (000028), and the refresh_token_hash index is still there for refresh.
func TestSessionIndexesServeTheirQueries(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	createSessionWithHash(t, user, "index-test-token")

	// Index use is about the plan, not the (small) test table: rule out the
	// sequential scan and see which index the planner picks.
	explain := func(query string, args ...any) string {
		t.Helper()
		var plan strings.Builder
		err := testStore.ExecTx(ctx, func(q *Queries) error {
			db := q.db.(*sql.Tx)
			if _, err := db.ExecContext(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
				return err
			}
			rows, err := db.QueryContext(ctx, "EXPLAIN "+query, args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var line string
				if err := rows.Scan(&line); err != nil {
					return err
				}
				plan.WriteString(line + "\n")
			}
			return rows.Err()
		})
		require.NoError(t, err)
		return plan.String()
	}

	plan := explain(blockAllSessionsForUser, user.ID)
	require.Contains(t, plan, "idx_sessions_user_id_active", plan)

	plan = explain(getSessionByRefreshTokenHash, []byte("x"))
	require.Contains(t, plan, "refresh_token_hash", plan)
}
