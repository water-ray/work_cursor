package control

import (
	"context"
	"testing"
	"time"
)

func TestGetStateDoesNotBlockSubsequentRequests(t *testing.T) {
	store := newStartPrecheckTestStore(t)

	if _, err := store.GetState(context.Background()); err != nil {
		t.Fatalf("get state failed: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, _, err := store.CheckStartPreconditions(context.Background())
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("check start preconditions failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("check start preconditions blocked after get state")
	}
}
