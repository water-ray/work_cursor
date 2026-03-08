package control

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const maxOperationStatusRecords = 24

type runtimeOperationOptions struct {
	Type         OperationType
	ScopeKey     string
	Title        string
	ProgressText string
}

type runtimeOperationHandle struct {
	registry *runtimeOperationRegistry
	id       string
}

func (h runtimeOperationHandle) ID() string {
	return strings.TrimSpace(h.id)
}

func (h runtimeOperationHandle) UpdateProgress(progress string) {
	if h.registry == nil || strings.TrimSpace(h.id) == "" {
		return
	}
	h.registry.updateProgress(h.id, progress)
}

type runtimeOperationRegistry struct {
	mu            sync.Mutex
	store         *RuntimeStore
	seq           int64
	records       map[string]OperationStatus
	order         []string
	activeByScope map[string]string
}

func newRuntimeOperationRegistry(store *RuntimeStore) *runtimeOperationRegistry {
	return &runtimeOperationRegistry{
		store:         store,
		records:       map[string]OperationStatus{},
		order:         []string{},
		activeByScope: map[string]string{},
	}
}

func (r *runtimeOperationRegistry) Begin(
	options runtimeOperationOptions,
) (runtimeOperationHandle, OperationStatus, bool) {
	if r == nil {
		return runtimeOperationHandle{}, OperationStatus{}, false
	}
	scopeKey := strings.TrimSpace(options.ScopeKey)
	if scopeKey == "" {
		scopeKey = string(options.Type)
	}
	nowMS := time.Now().UnixMilli()
	r.mu.Lock()
	if existingID := strings.TrimSpace(r.activeByScope[scopeKey]); existingID != "" {
		if existing, ok := r.records[existingID]; ok &&
			(existing.Status == OperationStatusQueued || existing.Status == OperationStatusRunning) {
			r.mu.Unlock()
			return runtimeOperationHandle{registry: r, id: existingID}, existing, true
		}
		delete(r.activeByScope, scopeKey)
	}
	record := OperationStatus{
		ID:           r.nextIDLocked(options.Type),
		Type:         options.Type,
		ScopeKey:     scopeKey,
		Title:        strings.TrimSpace(options.Title),
		Status:       OperationStatusRunning,
		ProgressText: strings.TrimSpace(options.ProgressText),
		StartedAtMS:  nowMS,
	}
	r.activeByScope[scopeKey] = record.ID
	r.upsertLocked(record)
	r.mu.Unlock()
	r.publish(record)
	return runtimeOperationHandle{registry: r, id: record.ID}, record, false
}

func (r *runtimeOperationRegistry) Complete(
	handle runtimeOperationHandle,
	resultSnapshotRevision int64,
	err error,
) {
	if r == nil || strings.TrimSpace(handle.id) == "" {
		return
	}
	r.mu.Lock()
	record, ok := r.records[handle.id]
	if !ok {
		r.mu.Unlock()
		return
	}
	record.FinishedAtMS = time.Now().UnixMilli()
	record.ResultSnapshotRevision = resultSnapshotRevision
	if err != nil {
		record.Status = OperationStatusFailed
		record.ErrorMessage = strings.TrimSpace(err.Error())
	} else {
		record.Status = OperationStatusSuccess
		record.ErrorMessage = ""
	}
	r.upsertLocked(record)
	if strings.TrimSpace(record.ScopeKey) != "" && r.activeByScope[record.ScopeKey] == record.ID {
		delete(r.activeByScope, record.ScopeKey)
	}
	r.pruneLocked()
	r.mu.Unlock()
	r.publish(record)
}

func (r *runtimeOperationRegistry) Snapshot() []OperationStatus {
	if r == nil {
		return []OperationStatus{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]OperationStatus, 0, len(r.order))
	for _, id := range r.order {
		record, ok := r.records[id]
		if !ok {
			continue
		}
		result = append(result, record)
	}
	return result
}

func (r *runtimeOperationRegistry) updateProgress(id string, progress string) {
	if r == nil {
		return
	}
	progress = strings.TrimSpace(progress)
	r.mu.Lock()
	record, ok := r.records[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	if record.ProgressText == progress {
		r.mu.Unlock()
		return
	}
	record.ProgressText = progress
	r.upsertLocked(record)
	r.mu.Unlock()
	r.publish(record)
}

func (r *runtimeOperationRegistry) nextIDLocked(operationType OperationType) string {
	r.seq++
	label := strings.TrimSpace(string(operationType))
	if label == "" {
		label = "operation"
	}
	return fmt.Sprintf("%s-%d", label, r.seq)
}

func (r *runtimeOperationRegistry) upsertLocked(record OperationStatus) {
	r.records[record.ID] = record
	nextOrder := make([]string, 0, len(r.order)+1)
	nextOrder = append(nextOrder, record.ID)
	for _, id := range r.order {
		if id == record.ID {
			continue
		}
		nextOrder = append(nextOrder, id)
	}
	r.order = nextOrder
}

func (r *runtimeOperationRegistry) pruneLocked() {
	if len(r.order) <= maxOperationStatusRecords {
		return
	}
	for len(r.order) > maxOperationStatusRecords {
		lastIndex := len(r.order) - 1
		id := r.order[lastIndex]
		record, ok := r.records[id]
		if !ok {
			r.order = r.order[:lastIndex]
			continue
		}
		if record.Status == OperationStatusRunning || record.Status == OperationStatusQueued {
			break
		}
		delete(r.records, id)
		r.order = r.order[:lastIndex]
	}
}

func (r *runtimeOperationRegistry) publish(record OperationStatus) {
	if r == nil || r.store == nil {
		return
	}
	r.store.publishOperationStatus(record)
}

func stripOperationStatuses(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	snapshot.Operations = nil
}
