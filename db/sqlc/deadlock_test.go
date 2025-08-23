package db

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
)

func TestConcurrentUserUpdates_Deadlock(t *testing.T) {
	user1 := createTestUser(t)
	user2 := createTestUser(t)

	var wg sync.WaitGroup
	errChan := make(chan error, 2)

	wg.Add(1)
	go func() {
		defer wg.Done()

		time.Sleep(10 * time.Millisecond)

		_, err := testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID:             user1.ID,
				Username:       fmt.Sprintf("updated1_%d", time.Now().UnixNano()),
				Email:          fmt.Sprintf("test1_%d@example.com", time.Now().UnixNano()),
				FullName:       user1.FullName,
				Role:           user1.Role,
				HashedPassword: user1.HashedPassword,
			},
			CheckUniqueness: true,
		})
		if err != nil {
			errChan <- fmt.Errorf("goroutine 1: %w", err)
			return
		}

		_, err = testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID:             user2.ID,
				Username:       fmt.Sprintf("updated2_%d", time.Now().UnixNano()),
				Email:          fmt.Sprintf("test2_%d@example.com", time.Now().UnixNano()),
				FullName:       user2.FullName,
				HashedPassword: user2.HashedPassword,
				Role:           user2.Role,
			},
			CheckUniqueness: true,
		})
		if err != nil {
			errChan <- fmt.Errorf("goroutine 1 second update: %w", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()

		time.Sleep(10 * time.Millisecond)

		_, err := testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID:             user2.ID,
				Username:       fmt.Sprintf("updated3_%d", time.Now().UnixNano()),
				Email:          fmt.Sprintf("test3_%d@example.com", time.Now().UnixNano()),
				FullName:       user2.FullName,
				Role:           user2.Role,
				HashedPassword: user2.HashedPassword,
			},
			CheckUniqueness: true,
		})
		if err != nil {
			errChan <- fmt.Errorf("goroutine 2: %w", err)
			return
		}

		_, err = testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID:             user1.ID,
				Username:       fmt.Sprintf("updated4_%d", time.Now().UnixNano()),
				Email:          fmt.Sprintf("test4_%d@example.com", time.Now().UnixNano()),
				FullName:       user1.FullName,
				HashedPassword: user1.HashedPassword,
				Role:           user1.Role,
			},
			CheckUniqueness: true,
		})
		if err != nil {
			errChan <- fmt.Errorf("goroutine 2 second update: %w", err)
		}
	}()

	done := make(chan bool)
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:

		close(errChan)
		for err := range errChan {
			if err != nil {

				t.Logf("Expected potential deadlock/conflict: %v", err)
			}
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Test timed out - possible deadlock")
	}
}

func TestConcurrentPostOperations_Deadlock(t *testing.T) {
	user1, post1 := createTestUserWithPosts(t)
	user2, post2 := createTestUserWithPosts(t)

	var wg sync.WaitGroup
	errChan := make(chan error, 4)

	operations := []func(){

		func() {
			err := testStore.DeleteUserWithTransferTx(context.Background(), DeleteUserWithTransferTxParams{
				UserID:       user1.ID,
				TransferToID: user2.ID,
			})
			if err != nil {
				errChan <- fmt.Errorf("transfer user1 posts: %w", err)
			}
		},

		func() {
			err := testStore.DeletePostTx(context.Background(), post2.Post.ID)
			if err != nil {
				errChan <- fmt.Errorf("delete post2: %w", err)
			}
		},

		func() {
			_, err := testStore.CreatePostTx(context.Background(), CreatePostTxParams{
				CreatePostsParams: CreatePostsParams{
					Title:       gofakeit.Sentence(3),
					Content:     gofakeit.Paragraph(3, 5, 10, " "),
					Description: gofakeit.Sentence(10),
					UserID:      user1.ID,
					Username:    user1.Username,
					Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
				},
				AuthorIDs: []int64{user1.ID},
			})
			if err != nil {
				errChan <- fmt.Errorf("create new post: %w", err)
			}
		},

		func() {
			_, err := testQueries.UpdatePost(context.Background(), UpdatePostParams{
				ID:          post1.Post.ID,
				Title:       gofakeit.Sentence(3),
				Description: gofakeit.Sentence(10),
				Content:     gofakeit.Paragraph(3, 5, 10, " "),
				UserID:      user1.ID,
				Username:    user1.Username,
				Url:         post1.Post.Url,
			})
			if err != nil {
				errChan <- fmt.Errorf("update post: %w", err)
			}
		},
	}

	for _, op := range operations {
		wg.Add(1)
		go func(operation func()) {
			defer wg.Done()
			operation()
		}(op)
	}

	done := make(chan bool)
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		close(errChan)
		errorCount := 0
		for err := range errChan {
			if err != nil {
				errorCount++
				t.Logf("Concurrent operation error: %v", err)
			}
		}

		t.Logf("Total errors from concurrent operations: %d", errorCount)
	case <-time.After(30 * time.Second):
		t.Fatal("Test timed out - possible deadlock")
	}
}

func TestHighConcurrencyStress(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping stress test in short mode")
	}

	const numWorkers = 50
	const operationsPerWorker = 10

	var wg sync.WaitGroup
	errChan := make(chan error, numWorkers*operationsPerWorker)

	baseUsers := make([]User, 5)
	for i := range baseUsers {
		gofakeit.Seed(int64(i + 1000))
		baseUsers[i] = createTestUser(t)
	}

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()

			for op := 0; op < operationsPerWorker; op++ {

				switch op % 4 {
				case 0:
					user := baseUsers[op%len(baseUsers)]
					_, err := testStore.CreatePostTx(context.Background(), CreatePostTxParams{
						CreatePostsParams: CreatePostsParams{
							Title:       fmt.Sprintf("Post-%d-%d", workerID, op),
							Content:     gofakeit.Paragraph(3, 5, 10, " "),
							Description: gofakeit.Sentence(10),
							UserID:      user.ID,
							Username:    user.Username,
							Url:         fmt.Sprintf("https://example.com/posts/%d-%d", workerID, op),
						},
						AuthorIDs: []int64{user.ID},
					})
					if err != nil {
						errChan <- err
					}

				case 1:
					user := baseUsers[op%len(baseUsers)]

					uniqueUsername := fmt.Sprintf("%s_w%d_op%d_%d",
						user.Username, workerID, op, time.Now().UnixNano())
					uniqueEmail := fmt.Sprintf("w%d_op%d_%d_%s",
						workerID, op, time.Now().UnixNano(), user.Email)

					_, err := testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
						UpdateUserParams: UpdateUserParams{
							ID:             user.ID,
							Username:       uniqueUsername,
							FullName:       fmt.Sprintf("Updated-%d-%d", workerID, op),
							Email:          uniqueEmail,
							HashedPassword: user.HashedPassword,
							Role:           user.Role,
						},
						CheckUniqueness: false,
					})
					if err != nil {
						errChan <- err
					}

				case 2:
					_, err := testQueries.ListUsers(context.Background(), ListUsersParams{
						SortBy:      "",
						OffsetCount: int32(op * 5),
						LimitCount:  10,
					})
					if err != nil {
						errChan <- err
					}

				case 3:
					user := baseUsers[op%len(baseUsers)]
					_, err := testQueries.GetUser(context.Background(), user.ID)
					if err != nil {
						errChan <- err
					}
				}

				time.Sleep(time.Duration(op%10) * time.Millisecond)
			}
		}(w)
	}

	done := make(chan bool)
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		close(errChan)
		errorCount := 0
		duplicateErrors := 0
		otherErrors := 0

		for err := range errChan {
			if err != nil {
				errorCount++
				if strings.Contains(err.Error(), "duplicate key value") {
					duplicateErrors++
				} else {
					otherErrors++
					t.Logf("Non-duplicate error: %v", err)
				}
			}
		}

		t.Logf("Stress test completed:")
		t.Logf("  Total operations: %d", numWorkers*operationsPerWorker)
		t.Logf("  Total errors: %d", errorCount)
		t.Logf("  Duplicate key errors: %d", duplicateErrors)
		t.Logf("  Other errors: %d", otherErrors)

		totalOps := float64(numWorkers * operationsPerWorker)
		duplicateRate := float64(duplicateErrors) / totalOps
		otherErrorRate := float64(otherErrors) / totalOps

		t.Logf("  Duplicate error rate: %.2f%%", duplicateRate*100)
		t.Logf("  Other error rate: %.2f%%", otherErrorRate*100)

		if otherErrorRate > 0.05 {
			t.Fatalf("Non-duplicate error rate too high: %.2f%%", otherErrorRate*100)
		}

		if duplicateRate > 0.3 {
			t.Fatalf("Duplicate error rate too high: %.2f%% - check unique value generation", duplicateRate*100)
		}

	case <-time.After(60 * time.Second):
		t.Fatal("Stress test timed out - possible deadlock")
	}
}

func isDeadlock(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	return strings.Contains(errStr, "deadlock detected") ||
		strings.Contains(errStr, "could not serialize access")
}

func TestDeadlockDetection(t *testing.T) {
	user1 := createTestUser(t)
	user2 := createTestUser(t)

	deadlockCount := 0
	totalAttempts := 20

	for attempt := 0; attempt < totalAttempts; attempt++ {
		var wg sync.WaitGroup
		var err1, err2 error

		wg.Add(2)

		go func() {
			defer wg.Done()
			err1 = testStore.ExecTx(context.Background(), func(q *Queries) error {

				_, err := q.GetUser(context.Background(), user1.ID)
				if err != nil {
					return err
				}

				time.Sleep(10 * time.Millisecond)

				_, err = q.GetUser(context.Background(), user2.ID)
				return err
			})
		}()

		go func() {
			defer wg.Done()
			err2 = testStore.ExecTx(context.Background(), func(q *Queries) error {

				_, err := q.GetUser(context.Background(), user2.ID)
				if err != nil {
					return err
				}

				time.Sleep(10 * time.Millisecond)

				_, err = q.GetUser(context.Background(), user1.ID)
				return err
			})
		}()

		wg.Wait()

		if isDeadlock(err1) || isDeadlock(err2) {
			deadlockCount++
			t.Logf("Deadlock detected on attempt %d", attempt+1)
		}
	}

	t.Logf("Deadlocks detected: %d out of %d attempts", deadlockCount, totalAttempts)

}

func TestDeadlockWithPostsAndUsers(t *testing.T) {
	_, post1 := createTestUserWithPosts(t)
	user2, _ := createTestUserWithPosts(t)

	deadlockCount := 0
	totalAttempts := 10

	for attempt := 0; attempt < totalAttempts; attempt++ {
		var wg sync.WaitGroup
		var err1, err2 error

		wg.Add(2)

		go func() {
			defer wg.Done()
			err1 = testStore.ExecTx(context.Background(), func(q *Queries) error {

				_, err := q.UpdatePost(context.Background(), UpdatePostParams{
					ID:          post1.Post.ID,
					Title:       fmt.Sprintf("Updated-Tx1-%d", time.Now().UnixNano()),
					Content:     post1.Post.Content,
					Description: post1.Post.Description,
					UserID:      post1.Post.UserID,
					Username:    post1.Post.Username,
					Url:         post1.Post.Url,
				})
				if err != nil {
					return err
				}

				time.Sleep(100 * time.Millisecond)

				_, err = q.UpdateUser(context.Background(), UpdateUserParams{
					ID:             user2.ID,
					Username:       user2.Username,
					FullName:       fmt.Sprintf("Updated-Tx1-%d", time.Now().UnixNano()),
					Email:          user2.Email,
					HashedPassword: user2.HashedPassword,
					Role:           user2.Role,
				})
				return err
			})
		}()

		go func() {
			defer wg.Done()
			err2 = testStore.ExecTx(context.Background(), func(q *Queries) error {

				_, err := q.UpdateUser(context.Background(), UpdateUserParams{
					ID:             user2.ID,
					Username:       user2.Username,
					FullName:       fmt.Sprintf("Updated-Tx2-%d", time.Now().UnixNano()),
					Email:          user2.Email,
					HashedPassword: user2.HashedPassword,
					Role:           user2.Role,
				})
				if err != nil {
					return err
				}

				time.Sleep(100 * time.Millisecond)

				_, err = q.UpdatePost(context.Background(), UpdatePostParams{
					ID:          post1.Post.ID,
					Title:       fmt.Sprintf("Updated-Tx2-%d", time.Now().UnixNano()),
					Content:     post1.Post.Content,
					Description: post1.Post.Description,
					UserID:      post1.Post.UserID,
					Username:    post1.Post.Username,
					Url:         post1.Post.Url,
				})
				return err
			})
		}()

		wg.Wait()

		if isDeadlock(err1) || isDeadlock(err2) {
			deadlockCount++
			t.Logf("Deadlock detected on attempt %d", attempt+1)
		}
	}

	t.Logf("Cross-resource deadlocks detected: %d out of %d attempts", deadlockCount, totalAttempts)
}
