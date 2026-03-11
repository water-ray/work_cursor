export function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export function reorderListByMove(
  source: string[],
  moveIDs: string[],
  targetID: string,
  placeAfter: boolean,
): string[] {
  const moveSet = new Set(moveIDs);
  const remaining = source.filter((id) => !moveSet.has(id));
  const insertIndex = remaining.indexOf(targetID);
  if (insertIndex < 0) {
    return source;
  }
  const next = [...remaining];
  const index = placeAfter ? insertIndex + 1 : insertIndex;
  next.splice(index, 0, ...moveIDs);
  return next;
}
