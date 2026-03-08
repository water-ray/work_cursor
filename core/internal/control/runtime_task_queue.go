package control

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxBackgroundTaskRecords = 24

type runtimeTaskOptions struct {
	TaskType     BackgroundTaskType
	ScopeKey     string
	Title        string
	ProgressText string
	SuccessText  string
}

type runtimeTaskHandle struct {
	queue *runtimeTaskQueue
	id    string
}

func (h runtimeTaskHandle) ID() string {
	return strings.TrimSpace(h.id)
}

func (h runtimeTaskHandle) UpdateProgress(progress string) {
	if h.queue == nil || strings.TrimSpace(h.id) == "" {
		return
	}
	h.queue.updateProgress(h.id, progress)
}

type runtimeQueuedTask struct {
	options runtimeTaskOptions
	record  BackgroundTask
	run     func(runtimeTaskHandle) error
}

type runtimeTaskScopeState struct {
	runningTaskID string
	pending       []*runtimeQueuedTask
}

type runtimeTaskQueue struct {
	mu     sync.Mutex
	store  *RuntimeStore
	seq    int64
	tasks  map[string]BackgroundTask
	order  []string
	scopes map[string]*runtimeTaskScopeState
}

func newRuntimeTaskQueue(store *RuntimeStore) *runtimeTaskQueue {
	return &runtimeTaskQueue{
		store:  store,
		tasks:  map[string]BackgroundTask{},
		order:  []string{},
		scopes: map[string]*runtimeTaskScopeState{},
	}
}

func (q *runtimeTaskQueue) BeginForegroundTask(options runtimeTaskOptions) runtimeTaskHandle {
	if q == nil {
		return runtimeTaskHandle{}
	}
	nowMS := time.Now().UnixMilli()
	q.mu.Lock()
	record := BackgroundTask{
		ID:           q.nextTaskIDLocked(options.TaskType),
		Type:         options.TaskType,
		ScopeKey:     strings.TrimSpace(options.ScopeKey),
		Title:        strings.TrimSpace(options.Title),
		Status:       BackgroundTaskStatusRunning,
		ProgressText: strings.TrimSpace(options.ProgressText),
		StartedAtMS:  nowMS,
	}
	q.upsertTaskLocked(record)
	tasks := q.snapshotLocked()
	q.mu.Unlock()
	q.publishSnapshot(tasks)
	return runtimeTaskHandle{
		queue: q,
		id:    record.ID,
	}
}

func (q *runtimeTaskQueue) CompleteForegroundTask(handle runtimeTaskHandle, options runtimeTaskOptions, err error) {
	if q == nil || strings.TrimSpace(handle.id) == "" {
		return
	}
	if err != nil {
		q.finishTask(handle.id, BackgroundTaskStatusFailed, "", err)
		return
	}
	q.finishTask(handle.id, BackgroundTaskStatusSuccess, options.SuccessText, nil)
}

func (q *runtimeTaskQueue) EnqueueLatest(
	options runtimeTaskOptions,
	run func(runtimeTaskHandle) error,
) runtimeTaskHandle {
	if q == nil {
		return runtimeTaskHandle{}
	}
	scopeKey := strings.TrimSpace(options.ScopeKey)
	if scopeKey == "" {
		scopeKey = string(options.TaskType)
	}
	task := &runtimeQueuedTask{
		options: options,
		record: BackgroundTask{
			ID:           q.nextTaskID(options.TaskType),
			Type:         options.TaskType,
			ScopeKey:     scopeKey,
			Title:        strings.TrimSpace(options.Title),
			Status:       BackgroundTaskStatusQueued,
			ProgressText: strings.TrimSpace(options.ProgressText),
		},
		run: run,
	}
	handle := runtimeTaskHandle{
		queue: q,
		id:    task.record.ID,
	}

	q.mu.Lock()
	scope := q.scopeLocked(scopeKey)
	if scope.hasRunningTask() {
		scope.pending = append(scope.pending, task)
		q.refreshQueuedMetadataLocked(scope)
		tasks := q.snapshotLocked()
		q.mu.Unlock()
		q.publishSnapshot(tasks)
		return handle
	}
	runningTask := q.markQueuedTaskRunningLocked(scope, task)
	tasks := q.snapshotLocked()
	q.mu.Unlock()
	q.publishSnapshot(tasks)
	go q.runScopedTask(scopeKey, runningTask)
	return handle
}

func (q *runtimeTaskQueue) runScopedTask(scopeKey string, task *runtimeQueuedTask) {
	current := task
	for current != nil {
		handle := runtimeTaskHandle{
			queue: q,
			id:    current.record.ID,
		}
		err := current.run(handle)
		if err != nil {
			q.finishTask(handle.id, BackgroundTaskStatusFailed, "", err)
		} else {
			q.finishTask(handle.id, BackgroundTaskStatusSuccess, current.options.SuccessText, nil)
		}

		q.mu.Lock()
		scope := q.scopeLocked(scopeKey)
		if len(scope.pending) == 0 {
			scope.runningTaskID = ""
			q.pruneFinishedTasksLocked()
			tasks := q.snapshotLocked()
			q.mu.Unlock()
			q.publishSnapshot(tasks)
			return
		}
		next := scope.pending[0]
		scope.pending = append([]*runtimeQueuedTask{}, scope.pending[1:]...)
		current = q.markQueuedTaskRunningLocked(scope, next)
		q.refreshQueuedMetadataLocked(scope)
		tasks := q.snapshotLocked()
		q.mu.Unlock()
		q.publishSnapshot(tasks)
	}
}

func (q *runtimeTaskQueue) finishTask(id string, status BackgroundTaskStatus, successText string, err error) {
	if q == nil {
		return
	}
	q.mu.Lock()
	record, ok := q.tasks[id]
	if !ok {
		q.mu.Unlock()
		return
	}
	record.Status = status
	record.FinishedAtMS = time.Now().UnixMilli()
	if strings.TrimSpace(successText) != "" && status == BackgroundTaskStatusSuccess {
		record.ProgressText = strings.TrimSpace(successText)
	}
	if err != nil {
		record.ErrorMessage = strings.TrimSpace(err.Error())
	}
	q.upsertTaskLocked(record)
	q.pruneFinishedTasksLocked()
	tasks := q.snapshotLocked()
	q.mu.Unlock()
	q.publishSnapshot(tasks)
}

func (q *runtimeTaskQueue) updateProgress(id string, progress string) {
	if q == nil {
		return
	}
	progress = strings.TrimSpace(progress)
	q.mu.Lock()
	record, ok := q.tasks[id]
	if !ok {
		q.mu.Unlock()
		return
	}
	if record.ProgressText == progress {
		q.mu.Unlock()
		return
	}
	record.ProgressText = progress
	q.upsertTaskLocked(record)
	tasks := q.snapshotLocked()
	q.mu.Unlock()
	q.publishSnapshot(tasks)
}

func (q *runtimeTaskQueue) Lookup(id string) (BackgroundTask, bool) {
	if q == nil || strings.TrimSpace(id) == "" {
		return BackgroundTask{}, false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	record, ok := q.tasks[id]
	if !ok {
		return BackgroundTask{}, false
	}
	return record, true
}

func (q *runtimeTaskQueue) RemoveQueued(taskID string) error {
	if q == nil {
		return fmt.Errorf("task queue is not available")
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return fmt.Errorf("task id is required")
	}
	q.mu.Lock()
	record, ok := q.tasks[taskID]
	if !ok {
		q.mu.Unlock()
		return fmt.Errorf("task not found")
	}
	if record.Status != BackgroundTaskStatusQueued {
		q.mu.Unlock()
		return fmt.Errorf("only queued tasks can be removed")
	}
	scope := q.scopeLocked(record.ScopeKey)
	removeIndex := -1
	for index, queuedTask := range scope.pending {
		if queuedTask == nil || strings.TrimSpace(queuedTask.record.ID) != taskID {
			continue
		}
		removeIndex = index
		break
	}
	if removeIndex < 0 {
		q.mu.Unlock()
		return fmt.Errorf("queued task not found in scope")
	}
	scope.pending = append(scope.pending[:removeIndex], scope.pending[removeIndex+1:]...)
	record.Status = BackgroundTaskStatusCancelled
	record.ProgressText = "已从队列移除"
	record.QueuePosition = 0
	record.WaitingForTaskID = ""
	record.WaitingForTaskTitle = ""
	record.FinishedAtMS = time.Now().UnixMilli()
	q.upsertTaskLocked(record)
	q.refreshQueuedMetadataLocked(scope)
	q.pruneFinishedTasksLocked()
	tasks := q.snapshotLocked()
	q.mu.Unlock()
	q.publishSnapshot(tasks)
	return nil
}

func (q *runtimeTaskQueue) scopeLocked(scopeKey string) *runtimeTaskScopeState {
	scopeKey = strings.TrimSpace(scopeKey)
	if scope, ok := q.scopes[scopeKey]; ok {
		return scope
	}
	scope := &runtimeTaskScopeState{}
	q.scopes[scopeKey] = scope
	return scope
}

func (q *runtimeTaskQueue) nextTaskID(taskType BackgroundTaskType) string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.nextTaskIDLocked(taskType)
}

func (q *runtimeTaskQueue) nextTaskIDLocked(taskType BackgroundTaskType) string {
	q.seq++
	label := strings.TrimSpace(string(taskType))
	if label == "" {
		label = "task"
	}
	return fmt.Sprintf("%s-%d", label, q.seq)
}

func (q *runtimeTaskQueue) markQueuedTaskRunningLocked(
	scope *runtimeTaskScopeState,
	task *runtimeQueuedTask,
) *runtimeQueuedTask {
	running := *task
	running.record.Status = BackgroundTaskStatusRunning
	running.record.StartedAtMS = time.Now().UnixMilli()
	running.record.QueuePosition = 0
	running.record.WaitingForTaskID = ""
	running.record.WaitingForTaskTitle = ""
	if scope != nil {
		scope.runningTaskID = running.record.ID
	}
	q.upsertTaskLocked(running.record)
	return &running
}

func (s *runtimeTaskScopeState) hasRunningTask() bool {
	return s != nil && strings.TrimSpace(s.runningTaskID) != ""
}

func (q *runtimeTaskQueue) refreshQueuedMetadataLocked(scope *runtimeTaskScopeState) {
	if scope == nil {
		return
	}
	waitingForTaskID := strings.TrimSpace(scope.runningTaskID)
	waitingForTaskTitle := ""
	if waitingForTaskID != "" {
		if runningTask, ok := q.tasks[waitingForTaskID]; ok {
			waitingForTaskTitle = strings.TrimSpace(runningTask.Title)
		}
	}
	for index, queuedTask := range scope.pending {
		if queuedTask == nil {
			continue
		}
		record := queuedTask.record
		record.Status = BackgroundTaskStatusQueued
		record.QueuePosition = index + 1
		record.WaitingForTaskID = waitingForTaskID
		record.WaitingForTaskTitle = waitingForTaskTitle
		queuedTask.record = record
		q.upsertTaskLocked(record)
	}
}

func (q *runtimeTaskQueue) upsertTaskLocked(task BackgroundTask) {
	if strings.TrimSpace(task.ID) == "" {
		return
	}
	if q.tasks == nil {
		q.tasks = map[string]BackgroundTask{}
	}
	if _, exists := q.tasks[task.ID]; !exists {
		q.order = append(q.order, task.ID)
	}
	q.tasks[task.ID] = task
}

func (q *runtimeTaskQueue) pruneFinishedTasksLocked() {
	finishedIDs := make([]string, 0)
	runningOrQueued := 0
	for _, taskID := range q.order {
		task, ok := q.tasks[taskID]
		if !ok {
			continue
		}
		if task.Status == BackgroundTaskStatusRunning || task.Status == BackgroundTaskStatusQueued {
			runningOrQueued++
			continue
		}
		finishedIDs = append(finishedIDs, taskID)
	}
	allowFinished := maxBackgroundTaskRecords - runningOrQueued
	if allowFinished < 0 {
		allowFinished = 0
	}
	if len(finishedIDs) <= allowFinished {
		return
	}
	removeCount := len(finishedIDs) - allowFinished
	removeSet := map[string]struct{}{}
	for _, taskID := range finishedIDs[:removeCount] {
		removeSet[taskID] = struct{}{}
		delete(q.tasks, taskID)
	}
	nextOrder := make([]string, 0, len(q.order)-removeCount)
	for _, taskID := range q.order {
		if _, removed := removeSet[taskID]; removed {
			continue
		}
		nextOrder = append(nextOrder, taskID)
	}
	q.order = nextOrder
}

func (q *runtimeTaskQueue) snapshotLocked() []BackgroundTask {
	tasks := make([]BackgroundTask, 0, len(q.order))
	for index := len(q.order) - 1; index >= 0; index-- {
		taskID := q.order[index]
		task, ok := q.tasks[taskID]
		if !ok {
			continue
		}
		tasks = append(tasks, task)
	}
	sort.SliceStable(tasks, func(i, j int) bool {
		leftWeight := backgroundTaskStatusWeight(tasks[i].Status)
		rightWeight := backgroundTaskStatusWeight(tasks[j].Status)
		if leftWeight != rightWeight {
			return leftWeight < rightWeight
		}
		leftTime := backgroundTaskSortTime(tasks[i])
		rightTime := backgroundTaskSortTime(tasks[j])
		return leftTime > rightTime
	})
	return cloneBackgroundTasks(tasks)
}

func backgroundTaskStatusWeight(status BackgroundTaskStatus) int {
	switch status {
	case BackgroundTaskStatusRunning:
		return 0
	case BackgroundTaskStatusQueued:
		return 1
	case BackgroundTaskStatusFailed:
		return 2
	case BackgroundTaskStatusSuccess:
		return 3
	default:
		return 4
	}
}

func backgroundTaskSortTime(task BackgroundTask) int64 {
	if task.FinishedAtMS > 0 {
		return task.FinishedAtMS
	}
	return task.StartedAtMS
}

func cloneBackgroundTasks(tasks []BackgroundTask) []BackgroundTask {
	if len(tasks) == 0 {
		return []BackgroundTask{}
	}
	cloned := make([]BackgroundTask, len(tasks))
	copy(cloned, tasks)
	return cloned
}

func stripBackgroundTasks(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	snapshot.ProbeRuntimeTasks = nil
	snapshot.BackgroundTasks = nil
}

func (q *runtimeTaskQueue) publishSnapshot(tasks []BackgroundTask) {
	if q == nil || q.store == nil {
		return
	}
	q.store.syncTaskQueueSnapshot(tasks)
}

func (s *RuntimeStore) syncTaskQueueSnapshot(tasks []BackgroundTask) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.BackgroundTasks = cloneBackgroundTasks(tasks)
	s.publishPushEventLocked(newTaskQueuePushEvent(s.state.StateRevision, s.state.BackgroundTasks))
}

func (s *RuntimeStore) withForegroundTask(
	options runtimeTaskOptions,
	run func(runtimeTaskHandle) error,
) error {
	if s.taskQueue == nil {
		return run(runtimeTaskHandle{})
	}
	handle := s.taskQueue.BeginForegroundTask(options)
	err := run(handle)
	s.taskQueue.CompleteForegroundTask(handle, options, err)
	return err
}
