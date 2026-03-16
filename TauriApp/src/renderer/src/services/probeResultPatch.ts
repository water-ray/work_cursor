import type {
  DaemonSnapshot,
  ProbeNodeResultPatch,
  ProbeResultPatchPayload,
  ProbeRuntimeTask,
  VpnNode,
} from "../../../shared/daemon";

function applyNodeResultPatch(node: VpnNode, patch: ProbeNodeResultPatch): VpnNode {
  let changed = false;
  const nextNode: VpnNode = { ...node };
  if (typeof patch.latencyMs === "number" && patch.latencyMs !== node.latencyMs) {
    nextNode.latencyMs = patch.latencyMs;
    changed = true;
  }
  if (
    typeof patch.latencyProbedAtMs === "number" &&
    patch.latencyProbedAtMs !== node.latencyProbedAtMs
  ) {
    nextNode.latencyProbedAtMs = patch.latencyProbedAtMs;
    changed = true;
  }
  if (
    typeof patch.realConnectMs === "number" &&
    patch.realConnectMs !== node.probeRealConnectMs
  ) {
    nextNode.probeRealConnectMs = patch.realConnectMs;
    changed = true;
  }
  if (
    typeof patch.realConnectProbedAtMs === "number" &&
    patch.realConnectProbedAtMs !== node.realConnectProbedAtMs
  ) {
    nextNode.realConnectProbedAtMs = patch.realConnectProbedAtMs;
    changed = true;
  }
  if (typeof patch.probeScore === "number" && patch.probeScore !== node.probeScore) {
    nextNode.probeScore = patch.probeScore;
    changed = true;
  }
  return changed ? nextNode : node;
}

function patchProbeRuntimeTasks(
  tasks: ProbeRuntimeTask[] | undefined,
  payload: ProbeResultPatchPayload,
): ProbeRuntimeTask[] {
  const currentTasks = Array.isArray(tasks) ? tasks : [];
  const patchByNodeId = new Map(payload.updates.map((item) => [item.nodeId, item]));
  return currentTasks.flatMap((task) => {
    if (task.taskId !== payload.taskId) {
      return [task];
    }
    if (payload.final) {
      return [];
    }
    const nextNodeStates = (task.nodeStates ?? []).flatMap((nodeState) => {
      const patch = patchByNodeId.get(nodeState.nodeId);
      if (!patch || (patch.completedStages ?? []).length === 0) {
        return [nodeState];
      }
      const remainingStages = (nodeState.pendingStages ?? []).filter(
        (stage) => !(patch.completedStages ?? []).includes(stage),
      );
      if (remainingStages.length === 0) {
        return [];
      }
      return [
        {
          ...nodeState,
          pendingStages: remainingStages,
        },
      ];
    });
    if (nextNodeStates.length === 0) {
      return [];
    }
    return [
      {
        ...task,
        nodeStates: nextNodeStates,
      },
    ];
  });
}

export function applyProbeResultPatchToSnapshot(
  snapshot: DaemonSnapshot,
  payload: ProbeResultPatchPayload,
): DaemonSnapshot {
  const patchByNodeId = new Map(payload.updates.map((item) => [item.nodeId, item]));
  const restrictGroupId = typeof payload.groupId === "string" ? payload.groupId.trim() : "";
  let groupsChanged = false;
  const nextGroups = snapshot.groups.map((group) => {
    if (restrictGroupId !== "" && group.id !== restrictGroupId) {
      return group;
    }
    let nodesChanged = false;
    const nextNodes = group.nodes.map((node) => {
      const patch = patchByNodeId.get(node.id);
      if (!patch) {
        return node;
      }
      const nextNode = applyNodeResultPatch(node, patch);
      if (nextNode !== node) {
        nodesChanged = true;
      }
      return nextNode;
    });
    if (!nodesChanged) {
      return group;
    }
    groupsChanged = true;
    return {
      ...group,
      nodes: nextNodes,
    };
  });
  const nextProbeRuntimeTasks = patchProbeRuntimeTasks(snapshot.probeRuntimeTasks, payload);
  const probeTasksChanged =
    nextProbeRuntimeTasks.length !== (snapshot.probeRuntimeTasks ?? []).length ||
    nextProbeRuntimeTasks.some((task, index) => task !== (snapshot.probeRuntimeTasks ?? [])[index]);
  if (!groupsChanged && !probeTasksChanged) {
    return snapshot;
  }
  return {
    ...snapshot,
    groups: groupsChanged ? nextGroups : snapshot.groups,
    probeRuntimeTasks: probeTasksChanged ? nextProbeRuntimeTasks : snapshot.probeRuntimeTasks,
  };
}
