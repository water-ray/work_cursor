import type { DaemonSnapshot } from "../../../shared/daemon";

const recentNodeSelectionsStorageKey = "wateray.ui.recentNodeSelections.v1";
const maxRecentNodeSelectionCount = 10;

export interface RecentNodeSelection {
  nodeId: string;
  groupId: string;
  nodeName: string;
  groupName: string;
  country: string;
  usedAtMs: number;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }
  return Math.round(numeric);
}

function parseRecentNodeSelection(value: unknown): RecentNodeSelection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const nodeId = normalizeText(record.nodeId);
  const groupId = normalizeText(record.groupId);
  if (nodeId === "" || groupId === "") {
    return null;
  }
  return {
    nodeId,
    groupId,
    nodeName: normalizeText(record.nodeName),
    groupName: normalizeText(record.groupName),
    country: normalizeText(record.country),
    usedAtMs: normalizeTimestamp(record.usedAtMs),
  };
}

function normalizeRecentNodeSelections(items: RecentNodeSelection[]): RecentNodeSelection[] {
  const dedupeKeys = new Set<string>();
  const nextItems: RecentNodeSelection[] = [];
  for (const item of items) {
    const normalized = parseRecentNodeSelection(item);
    if (!normalized) {
      continue;
    }
    const dedupeKey = `${normalized.groupId}:${normalized.nodeId}`;
    if (dedupeKeys.has(dedupeKey)) {
      continue;
    }
    dedupeKeys.add(dedupeKey);
    nextItems.push(normalized);
    if (nextItems.length >= maxRecentNodeSelectionCount) {
      break;
    }
  }
  return nextItems;
}

function readRecentNodeSelectionsStorage(): RecentNodeSelection[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(recentNodeSelectionsStorageKey);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeRecentNodeSelections(
      parsed
        .map((item) => parseRecentNodeSelection(item))
        .filter((item): item is RecentNodeSelection => item !== null),
    );
  } catch {
    return [];
  }
}

function writeRecentNodeSelectionsStorage(items: RecentNodeSelection[]): RecentNodeSelection[] {
  const normalized = normalizeRecentNodeSelections(items);
  if (typeof window === "undefined") {
    return normalized;
  }
  if (normalized.length === 0) {
    window.localStorage.removeItem(recentNodeSelectionsStorageKey);
    return normalized;
  }
  window.localStorage.setItem(recentNodeSelectionsStorageKey, JSON.stringify(normalized));
  return normalized;
}

export function readRecentNodeSelections(): RecentNodeSelection[] {
  return readRecentNodeSelectionsStorage();
}

export function replaceRecentNodeSelections(items: RecentNodeSelection[]): RecentNodeSelection[] {
  return writeRecentNodeSelectionsStorage(items);
}

export function sameRecentNodeSelections(
  left: RecentNodeSelection[],
  right: RecentNodeSelection[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const peer = right[index];
    return (
      peer != null
      && item.nodeId === peer.nodeId
      && item.groupId === peer.groupId
      && item.nodeName === peer.nodeName
      && item.groupName === peer.groupName
      && item.country === peer.country
      && item.usedAtMs === peer.usedAtMs
    );
  });
}

export function removeRecentNodeSelection(nodeId: string, groupId: string): RecentNodeSelection[] {
  const normalizedNodeId = normalizeText(nodeId);
  const normalizedGroupId = normalizeText(groupId);
  if (normalizedNodeId === "" || normalizedGroupId === "") {
    return readRecentNodeSelections();
  }
  return replaceRecentNodeSelections(
    readRecentNodeSelections().filter(
      (item) => item.nodeId !== normalizedNodeId || item.groupId !== normalizedGroupId,
    ),
  );
}

export function rememberRecentNodeSelection(
  input: Omit<RecentNodeSelection, "usedAtMs"> & { usedAtMs?: number },
): RecentNodeSelection[] {
  const nodeId = normalizeText(input.nodeId);
  const groupId = normalizeText(input.groupId);
  if (nodeId === "" || groupId === "") {
    return readRecentNodeSelections();
  }
  const nextItem: RecentNodeSelection = {
    nodeId,
    groupId,
    nodeName: normalizeText(input.nodeName),
    groupName: normalizeText(input.groupName),
    country: normalizeText(input.country),
    usedAtMs: normalizeTimestamp(input.usedAtMs),
  };
  const dedupeKey = `${groupId}:${nodeId}`;
  return replaceRecentNodeSelections([
    nextItem,
    ...readRecentNodeSelections().filter(
      (item) => `${item.groupId}:${item.nodeId}` !== dedupeKey,
    ),
  ]);
}

export function rememberSelectedNodeFromSnapshot(
  snapshot: DaemonSnapshot,
): RecentNodeSelection[] {
  const activeGroupId = normalizeText(snapshot.activeGroupId);
  const selectedNodeId = normalizeText(snapshot.selectedNodeId);
  if (activeGroupId === "" || selectedNodeId === "") {
    return readRecentNodeSelections();
  }
  const group = snapshot.groups.find((item) => item.id === activeGroupId);
  const node = (group?.nodes ?? []).find((item) => item.id === selectedNodeId);
  if (!group || !node) {
    return readRecentNodeSelections();
  }
  return rememberRecentNodeSelection({
    nodeId: node.id,
    groupId: group.id,
    nodeName: node.name,
    groupName: group.name,
    country: node.country || node.region || "",
  });
}

export function syncRecentNodeSelectionsWithSnapshot(
  snapshot: DaemonSnapshot,
  items: RecentNodeSelection[] = readRecentNodeSelections(),
): {
  items: RecentNodeSelection[];
  removed: RecentNodeSelection[];
} {
  const normalizedItems = normalizeRecentNodeSelections(items);
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const validItems: RecentNodeSelection[] = [];
  const removedItems: RecentNodeSelection[] = [];
  for (const item of normalizedItems) {
    const group = groupsById.get(item.groupId);
    const node = (group?.nodes ?? []).find((current) => current.id === item.nodeId);
    if (!group || !node) {
      removedItems.push(item);
      continue;
    }
    validItems.push({
      nodeId: node.id,
      groupId: group.id,
      nodeName: normalizeText(node.name) || item.nodeName,
      groupName: normalizeText(group.name) || item.groupName,
      country: normalizeText(node.country || node.region) || item.country,
      usedAtMs: item.usedAtMs,
    });
  }

  const persistedItems = sameRecentNodeSelections(normalizedItems, validItems)
    ? normalizedItems
    : replaceRecentNodeSelections(validItems);

  return {
    items: persistedItems,
    removed: removedItems,
  };
}
