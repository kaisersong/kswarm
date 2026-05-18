const GLOBAL_SEPARATOR = '__';
const LOCAL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function normalizeLocalTaskId(raw, fallbackIndex = 1) {
  const fallback = `item-${fallbackIndex}`;
  const input = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!input) return fallback;

  const normalized = input
    .replaceAll(GLOBAL_SEPARATOR, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  return normalized || fallback;
}

export function isGlobalTaskId(value) {
  return parseTaskId(value).global;
}

export function makeTaskId(projectId, localTaskId) {
  const parsed = parseTaskId(localTaskId);
  if (parsed.global) {
    if (parsed.projectId !== projectId) {
      return `${projectId}${GLOBAL_SEPARATOR}${normalizeLocalTaskId(parsed.localTaskId)}`;
    }
    return localTaskId;
  }
  return `${projectId}${GLOBAL_SEPARATOR}${normalizeLocalTaskId(localTaskId)}`;
}

export function parseTaskId(taskId) {
  if (typeof taskId !== 'string') return { global: false, taskId };
  const idx = taskId.indexOf(GLOBAL_SEPARATOR);
  if (idx <= 0 || idx !== taskId.lastIndexOf(GLOBAL_SEPARATOR)) {
    return { global: false, taskId };
  }

  const projectId = taskId.slice(0, idx);
  const localTaskId = taskId.slice(idx + GLOBAL_SEPARATOR.length);
  if (!projectId || !localTaskId || !LOCAL_ID_PATTERN.test(localTaskId)) {
    return { global: false, taskId };
  }
  return { global: true, projectId, localTaskId, taskId };
}

export function makeRunId(taskId, attempt = 1, now = Date.now()) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run-${taskId}-${now}-a${attempt}-${suffix}`;
}

export function normalizeTasksForProject(projectId, taskList, existingTasks = []) {
  const allByGlobal = new Map();
  const aliases = new Map();

  for (const task of existingTasks) {
    const normalized = normalizeExistingTask(projectId, task);
    allByGlobal.set(normalized.id, normalized);
    addAlias(aliases, normalized.id, normalized.id);
    addAlias(aliases, normalized.localTaskId, normalized.id);
    if (normalized.legacyTaskId) addAlias(aliases, normalized.legacyTaskId, normalized.id);
    if (normalized.planItemId) addAlias(aliases, normalized.planItemId, normalized.id);
  }

  const prepared = [];
  const usedLocalIds = new Set([...allByGlobal.values()].map(t => t.localTaskId));

  for (let i = 0; i < taskList.length; i++) {
    const input = taskList[i] || {};
    if (!isExecutableTaskInput(input)) continue;

    const parsed = parseTaskId(input.id);
    const rawLocalTaskId = parsed.global ? parsed.localTaskId : (input.id || input.planItemId || `item-${i + 1}`);
    const localTaskId = normalizeLocalTaskId(rawLocalTaskId, i + 1);
    if (usedLocalIds.has(localTaskId)) {
      return { ok: false, error: 'duplicate_local_task_id', localTaskId, sourceId: input.id };
    }
    usedLocalIds.add(localTaskId);

    const id = makeTaskId(projectId, localTaskId);
    const task = {
      ...input,
      id,
      projectId,
      localTaskId,
      displayTaskId: input.displayTaskId || input.id || localTaskId,
      legacyTaskId: input.legacyTaskId || input.id || localTaskId,
      planItemId: input.planItemId || input.id || localTaskId,
      dependencyRefs: Array.isArray(input.dependencies) ? [...input.dependencies] : [],
      unresolvedDependencies: [],
      activeRunId: input.activeRunId || null,
    };

    prepared.push(task);
    allByGlobal.set(id, task);
    addAlias(aliases, id, id);
    addAlias(aliases, localTaskId, id);
    addAlias(aliases, task.displayTaskId, id);
    addAlias(aliases, task.legacyTaskId, id);
    addAlias(aliases, task.planItemId, id);
  }

  addResolvableTitleAliases(projectId, aliases, allByGlobal.values());

  for (const task of prepared) {
    const normalizedDeps = [];
    const unresolved = [];
    for (const ref of task.dependencyRefs) {
      const resolved = resolveTaskRefFromAliases(projectId, ref, aliases);
      if (resolved?.taskId) normalizedDeps.push(resolved.taskId);
      else unresolved.push(ref);
    }
    task.dependencies = normalizedDeps;
    task.unresolvedDependencies = unresolved;
  }

  return { ok: true, tasks: prepared };
}

export function isExecutableTaskInput(input = {}) {
  if (!input || typeof input !== 'object') return false;
  return [input.title, input.brief, input.description].some(value => String(value || '').trim().length > 0);
}

export function normalizeExistingTask(projectId, task) {
  const parsed = parseTaskId(task.id);
  const localTaskId = normalizeLocalTaskId(
    task.localTaskId || (parsed.global ? parsed.localTaskId : task.id || task.planItemId),
  );
  const id = makeTaskId(projectId, localTaskId);
  return {
    ...task,
    id,
    projectId,
    localTaskId,
    displayTaskId: task.displayTaskId || task.legacyTaskId || task.id || localTaskId,
    legacyTaskId: task.legacyTaskId || (parsed.global ? localTaskId : task.id),
    planItemId: task.planItemId || localTaskId,
    activeRunId: task.activeRunId || null,
    dependencyRefs: Array.isArray(task.dependencyRefs)
      ? task.dependencyRefs
      : Array.isArray(task.dependencies) ? [...task.dependencies] : [],
    unresolvedDependencies: Array.isArray(task.unresolvedDependencies) ? task.unresolvedDependencies : [],
  };
}

export function buildTaskAliases(projectId, tasks) {
  const aliases = new Map();
  const normalized = tasks.map(t => normalizeExistingTask(projectId, t));
  for (const task of normalized) {
    addAlias(aliases, task.id, task.id);
    addAlias(aliases, task.localTaskId, task.id);
    addAlias(aliases, task.displayTaskId, task.id);
    addAlias(aliases, task.legacyTaskId, task.id);
    addAlias(aliases, task.planItemId, task.id);
  }
  addResolvableTitleAliases(projectId, aliases, normalized);
  return aliases;
}

export function resolveTaskRef(projectId, taskRef, tasks) {
  const aliases = buildTaskAliases(projectId, tasks);
  return resolveTaskRefFromAliases(projectId, taskRef, aliases);
}

function resolveTaskRefFromAliases(projectId, taskRef, aliases) {
  const parsed = parseTaskId(taskRef);
  if (parsed.global) {
    if (parsed.projectId !== projectId) return null;
    return aliases.has(taskRef) ? { taskId: taskRef, via: 'global' } : null;
  }
  const direct = aliases.get(taskRef);
  if (direct) return { taskId: direct, via: 'alias' };
  const normalized = normalizeLocalTaskId(taskRef);
  const byNormalized = aliases.get(normalized);
  if (byNormalized) return { taskId: byNormalized, via: 'normalized' };
  return null;
}

function addResolvableTitleAliases(projectId, aliases, tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (!task.title) continue;
    const group = groups.get(task.title) || [];
    group.push(task);
    groups.set(task.title, group);
  }

  for (const [title, group] of groups.entries()) {
    const target = resolveTitleAliasTarget(projectId, group);
    if (target) addAlias(aliases, title, target.id);
  }
}

function resolveTitleAliasTarget(projectId, group) {
  if (group.length === 1) return group[0];

  const roots = group.filter(task => !isRetryChild(projectId, task));
  if (roots.length !== 1) return null;

  const root = roots[0];
  const rootId = makeTaskId(projectId, root.id);
  const allRetryChildrenOfRoot = group.every(task => (
    task.id === rootId || isRetryChildOf(projectId, task, rootId)
  ));

  return allRetryChildrenOfRoot ? root : null;
}

function isRetryChild(projectId, task) {
  return Boolean(getRetryParentId(projectId, task) && isRetryLikeTask(task));
}

function isRetryChildOf(projectId, task, parentTaskId) {
  return getRetryParentId(projectId, task) === parentTaskId && isRetryLikeTask(task);
}

function getRetryParentId(projectId, task) {
  const parentRef = task.parentTaskId || task.retryOfTaskId;
  return parentRef ? makeTaskId(projectId, parentRef) : null;
}

function isRetryLikeTask(task) {
  return Boolean(
    task.retryOfTaskId ||
    String(task.id || '').includes('-retry-') ||
    Number(task.attempt || 1) > 1,
  );
}

function addAlias(aliases, key, taskId) {
  if (!key || !taskId) return;
  if (aliases.has(key) && aliases.get(key) !== taskId) {
    aliases.delete(key);
    return;
  }
  aliases.set(key, taskId);
}
