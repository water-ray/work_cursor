package control

import (
	"context"
	"testing"
)

func TestAddSubscriptionDoesNotChangeActiveGroup(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:    "group-existing",
			Name:  "Existing",
			Kind:  "manual",
			Nodes: []Node{},
		},
	}
	store.state.ActiveGroupID = "group-existing"
	store.ensureValidLocked()

	snapshot, err := store.AddSubscription(context.Background(), AddSubscriptionRequest{
		Name: "New Manual",
		URL:  "",
	})
	if err != nil {
		t.Fatalf("add manual group failed: %v", err)
	}
	if snapshot.ActiveGroupID != "group-existing" {
		t.Fatalf("expected active group to stay unchanged, got %s", snapshot.ActiveGroupID)
	}

	snapshot, err = store.AddSubscription(context.Background(), AddSubscriptionRequest{
		Name: "New Subscription",
		URL:  "https://example.com/subscription",
	})
	if err != nil {
		t.Fatalf("add subscription group failed: %v", err)
	}
	if snapshot.ActiveGroupID != "group-existing" {
		t.Fatalf("expected active group to stay unchanged after subscription add, got %s", snapshot.ActiveGroupID)
	}
}
