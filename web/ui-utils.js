export function latestBatchStart(total, batchSize) {
  return Math.max(0, Math.max(0, total) - Math.max(1, batchSize));
}

export function olderBatchStart(currentStart, batchSize) {
  return Math.max(0, Math.max(0, currentStart) - Math.max(1, batchSize));
}

export function preserveScrollTop(oldTop, oldHeight, newHeight) {
  return Math.max(0, oldTop + Math.max(0, newHeight - oldHeight));
}

export function preserveBottomOffset(oldTop, scrollHeight, oldClientHeight, newClientHeight) {
  const bottomOffset = Math.max(0, scrollHeight - oldClientHeight - oldTop);
  return Math.max(0, scrollHeight - newClientHeight - bottomOffset);
}

export function preserveScrollRatio(oldTop, oldScrollHeight, oldClientHeight, newScrollHeight, newClientHeight) {
  const oldRange = Math.max(0, oldScrollHeight - oldClientHeight);
  const newRange = Math.max(0, newScrollHeight - newClientHeight);
  if (!oldRange || !newRange) return 0;
  return Math.max(0, Math.min(newRange, (oldTop / oldRange) * newRange));
}

export function sortThreadsByUpdatedAt(threads) {
  return [...threads].sort((left, right) => {
    const leftTime = Date.parse(left?.updatedAt) || 0;
    const rightTime = Date.parse(right?.updatedAt) || 0;
    return rightTime - leftTime;
  });
}

export function buildThreadTree(threads) {
  const nodes = new Map((threads ?? []).map((thread) => [thread.id, { thread, children: [] }]));
  const roots = [];

  const validParentId = (thread) => {
    if (thread?.relation?.kind !== "side-task" || !nodes.has(thread.relation.parentId)) return null;
    const seen = new Set([thread.id]);
    let cursor = thread.relation.parentId;
    while (cursor) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const parent = nodes.get(cursor)?.thread;
      cursor = parent?.relation?.kind === "side-task" ? parent.relation.parentId : null;
    }
    return thread.relation.parentId;
  };

  for (const node of nodes.values()) {
    const parentId = validParentId(node.thread);
    if (parentId) nodes.get(parentId).children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items) => {
    items.sort((left, right) => {
      const leftTime = Date.parse(left.thread?.updatedAt) || 0;
      const rightTime = Date.parse(right.thread?.updatedAt) || 0;
      return rightTime - leftTime;
    });
    items.forEach((item) => sortNodes(item.children));
    return items;
  };
  return sortNodes(roots);
}

export function filterThreadTree(nodes, matches) {
  const matchSet = matches instanceof Set ? matches : new Set(matches ?? []);
  const visit = (node) => {
    if (matchSet.has(node.thread.id)) return node;
    const children = node.children.map(visit).filter(Boolean);
    return children.length ? { ...node, children } : null;
  };
  return (nodes ?? []).map(visit).filter(Boolean);
}

export function resolveTheme(storedTheme, prefersDark = false) {
  if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
  return prefersDark ? "dark" : "light";
}

export function canToggleConversationTitle({
  distance = 0, scrollDelta = 0, durationMs = 0, hadMultiplePointers = false,
  interactiveTarget = false, hasSelection = false
} = {}) {
  return distance <= 10
    && scrollDelta <= 4
    && durationMs <= 650
    && !hadMultiplePointers
    && !interactiveTarget
    && !hasSelection;
}

export function remainingMessagesBeforeChunk(chunks, chunkIndex) {
  if (!Array.isArray(chunks) || chunkIndex < 0 || chunkIndex >= chunks.length) return 0;
  return Math.max(0, Number(chunks[chunkIndex]?.start) || 0);
}

export function clampReaderScale(value, minimum = 0.85, maximum = 1.3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(maximum, Math.max(minimum, numeric));
}

export function pointDistance(left, right) {
  return Math.hypot(Number(right?.x) - Number(left?.x), Number(right?.y) - Number(left?.y));
}

export function readerScaleFromPinch({
  startScale, startDistance, currentDistance, active = false,
  activationRatio = 0.12, minimum = 0.85, maximum = 1.3
}) {
  const initial = clampReaderScale(startScale, minimum, maximum);
  if (!(startDistance > 0) || !(currentDistance > 0)) return { active: false, scale: initial };
  const ratio = currentDistance / startDistance;
  const nextActive = active || Math.abs(ratio - 1) >= activationRatio;
  return {
    active: nextActive,
    scale: nextActive ? clampReaderScale(initial * ratio, minimum, maximum) : initial
  };
}
