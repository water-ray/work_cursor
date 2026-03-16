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

func TestAddSubscriptionTreatsNonEmptyURLAsSubscriptionGroup(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}

	snapshot, err := store.AddSubscription(context.Background(), AddSubscriptionRequest{
		Name: "Non Empty URL Group",
		URL:  "ftp://example.com/subscription",
	})
	if err != nil {
		t.Fatalf("add non-empty-url group failed: %v", err)
	}
	if len(snapshot.Groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(snapshot.Groups))
	}
	if snapshot.Groups[0].Kind != "subscription" {
		t.Fatalf("expected non-empty URL group to become subscription, got %s", snapshot.Groups[0].Kind)
	}
	if snapshot.Groups[0].SubscriptionID == "" {
		t.Fatalf("expected subscription group subscription id to be set")
	}
	if len(snapshot.Subscriptions) != 1 {
		t.Fatalf("expected 1 subscription source for non-empty URL, got %d", len(snapshot.Subscriptions))
	}
}

func TestUpdateGroupTreatsNonEmptyURLAsSubscriptionGroup(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "grp-1",
			Name: "Before",
			Kind: "manual",
			Nodes: []Node{
				{ID: "node-1", Name: "node-1"},
			},
		},
	}

	snapshot, err := store.UpdateGroup(context.Background(), UpdateGroupRequest{
		GroupID: "grp-1",
		Name:    "After",
		URL:     "not-a-valid-url",
	})
	if err != nil {
		t.Fatalf("update group with non-empty url failed: %v", err)
	}
	if len(snapshot.Groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(snapshot.Groups))
	}
	group := snapshot.Groups[0]
	if group.Kind != "subscription" {
		t.Fatalf("expected group kind subscription, got %s", group.Kind)
	}
	if group.SubscriptionID == "" {
		t.Fatalf("expected subscription id to be set, got empty")
	}
	if len(group.Nodes) != 1 {
		t.Fatalf("expected existing nodes to be kept, got %d", len(group.Nodes))
	}
	if len(snapshot.Subscriptions) != 1 {
		t.Fatalf("expected non-empty url update to create subscription source, got %d", len(snapshot.Subscriptions))
	}
}

func TestRemoveNodesRemovesMultipleNodesAcrossGroups(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "grp-1",
			Name: "Group 1",
			Kind: "manual",
			Nodes: []Node{
				{ID: "node-1", Name: "node-1"},
				{ID: "node-2", Name: "node-2"},
				{ID: "node-3", Name: "node-3"},
			},
		},
		{
			ID:   "grp-2",
			Name: "Group 2",
			Kind: "manual",
			Nodes: []Node{
				{ID: "node-4", Name: "node-4"},
				{ID: "node-5", Name: "node-5"},
			},
		},
	}

	snapshot, err := store.RemoveNodes(context.Background(), RemoveNodesRequest{
		Items: []RemoveNodeItem{
			{GroupID: "grp-1", NodeID: "node-1"},
			{GroupID: "grp-1", NodeID: "node-3"},
			{GroupID: "grp-2", NodeID: "node-4"},
		},
	})
	if err != nil {
		t.Fatalf("remove nodes failed: %v", err)
	}
	if len(snapshot.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(snapshot.Groups))
	}
	if len(snapshot.Groups[0].Nodes) != 1 || snapshot.Groups[0].Nodes[0].ID != "node-2" {
		t.Fatalf("expected grp-1 to keep only node-2, got %+v", snapshot.Groups[0].Nodes)
	}
	if len(snapshot.Groups[1].Nodes) != 1 || snapshot.Groups[1].Nodes[0].ID != "node-5" {
		t.Fatalf("expected grp-2 to keep only node-5, got %+v", snapshot.Groups[1].Nodes)
	}
}
