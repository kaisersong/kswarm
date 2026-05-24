import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VALID_TARGETS = new Set(['user_knowledge_overlay', 'workspace_knowledge_overlay']);
const VALID_OPS = new Set(['upsert_rule']);
const VALID_SEVERITIES = new Set(['hard', 'soft']);

export function validateQualityPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object') {
    return { ok: false, errors: ['patch must be an object'] };
  }
  if (patch.initiatedBy !== 'user') errors.push('initiatedBy must be user');
  if (patch.confirmedBy !== 'user') errors.push('confirmedBy must be user');
  if (patch.trustedInput !== true) errors.push('trustedInput must be true');
  if (patch.sourceArtifactId || patch.sourceToolCallId || patch.sourceAgentMessageId) {
    errors.push('artifact/tool output cannot source durable rules');
  }
  if (!patch.patchId || typeof patch.patchId !== 'string') errors.push('patchId is required');
  if (!VALID_TARGETS.has(patch.target)) errors.push('target must be user_knowledge_overlay or workspace_knowledge_overlay');
  if (!Array.isArray(patch.affectedPacks) || patch.affectedPacks.length === 0) errors.push('affectedPacks must be a non-empty array');
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) errors.push('operations must be a non-empty array');

  for (const op of Array.isArray(patch.operations) ? patch.operations : []) {
    if (!VALID_OPS.has(op?.op)) errors.push('operation must be upsert_rule');
    const rule = op?.rule;
    if (!rule || typeof rule !== 'object') {
      errors.push('operation.rule is required');
      continue;
    }
    if (!rule.id || typeof rule.id !== 'string') errors.push('rule.id is required');
    if (!rule.packId || typeof rule.packId !== 'string') errors.push('rule.packId is required');
    if (!VALID_SEVERITIES.has(rule.severity)) errors.push('rule.severity must be hard or soft');
    if (!Array.isArray(rule.appliesTo) || rule.appliesTo.length === 0) errors.push('rule.appliesTo must be a non-empty array');
    if (!rule.description || typeof rule.description !== 'string') errors.push('rule.description is required');
  }

  return errors.length === 0 ? { ok: true, patch } : { ok: false, errors };
}

export function applyQualityPatch(state, patch) {
  const validation = validateQualityPatch(patch);
  if (!validation.ok) return validation;

  const next = normalizeOverlayState(state);
  const scope = patch.target === 'workspace_knowledge_overlay' ? 'workspace' : 'user';
  const overlays = [];
  for (const operation of patch.operations) {
    if (operation.op !== 'upsert_rule') continue;
    overlays.push(materializeOverlayRule(operation.rule, patch, scope));
  }

  const replaceIds = new Set(overlays.map(rule => `${rule.scope}:${rule.id}`));
  next.overlays = [
    ...next.overlays.filter(rule => !replaceIds.has(`${rule.scope}:${rule.id}`)),
    ...overlays,
  ].sort(compareOverlayRules);
  next.patches = [
    ...next.patches.filter(item => item.patchId !== patch.patchId),
    normalizePatchRecord(patch),
  ].sort((a, b) => String(a.patchId).localeCompare(String(b.patchId)));
  next.version += 1;

  return { ok: true, state: next, appliedPatch: normalizePatchRecord(patch) };
}

export function createInMemoryQualityOverlayStore(initialState) {
  let state = normalizeOverlayState(initialState);
  return {
    listState() {
      return clone(state);
    },
    listOverlays() {
      return clone(state.overlays);
    },
    applyPatch(patch) {
      const result = applyQualityPatch(state, patch);
      if (result.ok) state = result.state;
      return clone(result);
    },
  };
}

export function createQualityOverlayStore(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  let state = loadState(filePath);
  return {
    listState() {
      return clone(state);
    },
    listOverlays() {
      return clone(state.overlays);
    },
    applyPatch(patch) {
      const result = applyQualityPatch(state, patch);
      if (result.ok) {
        state = result.state;
        writeFileSync(filePath, JSON.stringify(state, null, 2));
      }
      return clone(result);
    },
  };
}

function loadState(filePath) {
  if (!existsSync(filePath)) return normalizeOverlayState();
  try {
    return normalizeOverlayState(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return normalizeOverlayState();
  }
}

function normalizeOverlayState(state = {}) {
  return {
    version: Number.isFinite(state?.version) ? state.version : 0,
    overlays: Array.isArray(state?.overlays) ? state.overlays.map(normalizeOverlayRule).filter(Boolean).sort(compareOverlayRules) : [],
    patches: Array.isArray(state?.patches) ? state.patches.map(normalizePatchRecord).sort((a, b) => String(a.patchId).localeCompare(String(b.patchId))) : [],
  };
}

function materializeOverlayRule(rule, patch, scope) {
  return normalizeOverlayRule({
    id: rule.id,
    packId: rule.packId,
    severity: rule.severity,
    defaultSeverity: rule.defaultSeverity || rule.severity,
    appliesTo: [...rule.appliesTo],
    description: rule.description,
    promptExcerpt: { ...(rule.promptExcerpt || {}) },
    metadata: { ...(rule.metadata || {}), kind: rule.metadata?.kind || 'overlay', scope, patchId: patch.patchId },
    enabled: rule.enabled !== false,
    scope,
    source: `${scope}:${patch.patchId}@1`,
    patchId: patch.patchId,
    provenance: {
      patchId: patch.patchId,
      initiatedBy: patch.initiatedBy,
      confirmedBy: patch.confirmedBy,
      sourceMessageId: patch.sourceMessageId || null,
      conversationId: patch.conversationId || null,
      trustedInput: patch.trustedInput,
      target: patch.target,
      affectedPacks: [...patch.affectedPacks],
      createdAt: patch.createdAt || null,
      compilerVersion: patch.compilerVersion || null,
    },
  });
}

function normalizeOverlayRule(rule) {
  if (!rule?.id || !rule?.packId || !rule?.severity) return null;
  const scope = rule.scope === 'workspace' ? 'workspace' : 'user';
  return {
    id: rule.id,
    packId: rule.packId,
    severity: rule.severity,
    defaultSeverity: rule.defaultSeverity || rule.severity,
    appliesTo: Array.isArray(rule.appliesTo) ? [...rule.appliesTo] : ['planning'],
    description: rule.description || '',
    promptExcerpt: { ...(rule.promptExcerpt || {}) },
    metadata: { ...(rule.metadata || {}), kind: rule.metadata?.kind || 'overlay', scope, patchId: rule.patchId || rule.metadata?.patchId || null },
    enabled: rule.enabled !== false,
    scope,
    source: rule.source || `${scope}:${rule.patchId || 'manual'}@1`,
    patchId: rule.patchId || rule.metadata?.patchId || null,
    provenance: rule.provenance || null,
  };
}

function normalizePatchRecord(patch) {
  return {
    patchId: patch.patchId,
    initiatedBy: patch.initiatedBy,
    confirmedBy: patch.confirmedBy,
    sourceMessageId: patch.sourceMessageId || null,
    conversationId: patch.conversationId || null,
    trustedInput: patch.trustedInput === true,
    target: patch.target,
    affectedPacks: Array.isArray(patch.affectedPacks) ? [...patch.affectedPacks] : [],
    createdAt: patch.createdAt || null,
    compilerVersion: patch.compilerVersion || null,
    operations: Array.isArray(patch.operations) ? clone(patch.operations) : [],
  };
}

function compareOverlayRules(left, right) {
  const scopeOrder = scope => scope === 'workspace' ? 0 : 1;
  return scopeOrder(left.scope) - scopeOrder(right.scope) || left.id.localeCompare(right.id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
