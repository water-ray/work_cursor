package control

import (
	"testing"
	"time"
)

func TestRuntimeTaskQueueMaintainsFIFOAndAllowsQueuedRemoval(t *testing.T) {
	q := newRuntimeTaskQueue(nil)
	options := runtimeTaskOptions{
		TaskType:     BackgroundTaskTypeNodeProbe,
		ScopeKey:     "node_probe:node_latency",
		Title:        "延迟探测：默认分组",
		ProgressText: "等待节点探测",
		SuccessText:  "节点探测完成",
	}
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondStarted := make(chan struct{})
	thirdStarted := make(chan struct{})

	q.EnqueueLatest(options, func(runtimeTaskHandle) error {
		close(firstStarted)
		<-releaseFirst
		return nil
	})
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("expected first task to start")
	}

	secondHandle := q.EnqueueLatest(options, func(runtimeTaskHandle) error {
		close(secondStarted)
		return nil
	})
	thirdHandle := q.EnqueueLatest(options, func(runtimeTaskHandle) error {
		close(thirdStarted)
		return nil
	})

	secondTask, ok := q.Lookup(secondHandle.ID())
	if !ok {
		t.Fatal("expected second task to be queued")
	}
	if secondTask.Status != BackgroundTaskStatusQueued {
		t.Fatalf("expected second task queued, got %s", secondTask.Status)
	}
	if secondTask.QueuePosition != 1 {
		t.Fatalf("expected second task queue position 1, got %d", secondTask.QueuePosition)
	}
	if secondTask.WaitingForTaskTitle != options.Title {
		t.Fatalf("expected second task waiting title %q, got %q", options.Title, secondTask.WaitingForTaskTitle)
	}

	thirdTask, ok := q.Lookup(thirdHandle.ID())
	if !ok {
		t.Fatal("expected third task to be queued")
	}
	if thirdTask.QueuePosition != 2 {
		t.Fatalf("expected third task queue position 2, got %d", thirdTask.QueuePosition)
	}

	if err := q.RemoveQueued(secondHandle.ID()); err != nil {
		t.Fatalf("expected queued removal to succeed: %v", err)
	}
	secondTask, ok = q.Lookup(secondHandle.ID())
	if !ok {
		t.Fatal("expected removed second task record to remain available")
	}
	if secondTask.Status != BackgroundTaskStatusCancelled {
		t.Fatalf("expected removed task cancelled, got %s", secondTask.Status)
	}
	if secondTask.ProgressText != "已从队列移除" {
		t.Fatalf("expected removal message, got %q", secondTask.ProgressText)
	}

	thirdTask, ok = q.Lookup(thirdHandle.ID())
	if !ok {
		t.Fatal("expected third task record after queued removal")
	}
	if thirdTask.QueuePosition != 1 {
		t.Fatalf("expected third task queue position to shift to 1, got %d", thirdTask.QueuePosition)
	}

	close(releaseFirst)
	select {
	case <-thirdStarted:
	case <-time.After(time.Second):
		t.Fatal("expected third task to start after first completed")
	}
	select {
	case <-secondStarted:
		t.Fatal("expected removed second task to never start")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestProbeRuntimeTaskLifecycle(t *testing.T) {
	store := &RuntimeStore{
		state:           defaultSnapshot("test", defaultUnifiedSemVerVersion),
		pushSubscribers: map[int]chan DaemonPushEvent{},
	}
	handle := runtimeTaskHandle{id: "probe-task-1"}

	started := store.beginProbeRuntimeTask(handle, []ProbeRuntimeNodeState{
		{
			NodeID:        "node-1",
			PendingStages: []ProbeRuntimeStage{ProbeRuntimeStageNodeLatency, ProbeRuntimeStageRealConnect},
		},
		{
			NodeID:        "node-2",
			PendingStages: []ProbeRuntimeStage{ProbeRuntimeStageCountryUpdate},
		},
	})
	if !started {
		t.Fatal("expected probe runtime task to start")
	}
	if len(store.state.ProbeRuntimeTasks) != 1 {
		t.Fatalf("expected 1 probe runtime task, got %d", len(store.state.ProbeRuntimeTasks))
	}

	cleared := store.clearProbeRuntimeNodeStages(
		handle.ID(),
		"node-1",
		[]ProbeRuntimeStage{ProbeRuntimeStageNodeLatency},
	)
	if !cleared {
		t.Fatal("expected node-1 latency stage to clear")
	}
	task := store.state.ProbeRuntimeTasks[0]
	if len(task.NodeStates) != 2 {
		t.Fatalf("expected task to keep 2 node states after partial clear, got %d", len(task.NodeStates))
	}
	if len(task.NodeStates[0].PendingStages) != 1 || task.NodeStates[0].PendingStages[0] != ProbeRuntimeStageRealConnect {
		t.Fatalf("expected node-1 to keep only real_connect pending, got %+v", task.NodeStates[0].PendingStages)
	}

	cleared = store.clearProbeRuntimeNodeStages(
		handle.ID(),
		"node-1",
		[]ProbeRuntimeStage{ProbeRuntimeStageRealConnect},
	)
	if !cleared {
		t.Fatal("expected node-1 real_connect stage to clear")
	}
	task = store.state.ProbeRuntimeTasks[0]
	if len(task.NodeStates) != 1 || task.NodeStates[0].NodeID != "node-2" {
		t.Fatalf("expected only node-2 to remain pending, got %+v", task.NodeStates)
	}

	finished := store.finishProbeRuntimeTask(handle.ID())
	if !finished {
		t.Fatal("expected probe runtime task to finish")
	}
	if len(store.state.ProbeRuntimeTasks) != 0 {
		t.Fatalf("expected probe runtime tasks to be cleared, got %d", len(store.state.ProbeRuntimeTasks))
	}
}
