import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createTeamOperationStore({ filePath }) {
  if (!filePath) throw new Error('filePath is required');
  const operations = new Map();
  load();

  function load() {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    const values = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const operation of Array.isArray(values) ? values : []) {
      if (operation?.id) operations.set(operation.id, operation);
    }
  }

  function save() {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify([...operations.values()], null, 2), 'utf8');
    renameSync(temporaryPath, filePath);
  }

  function get(id) { return operations.get(id) || null; }
  function findByClientRequest(projectId, clientRequestKey) {
    return [...operations.values()].find(operation => operation.projectId === projectId && operation.clientRequestKey === clientRequestKey) || null;
  }
  function findLatestByProject(projectId) {
    return [...operations.values()].reverse().find(operation => operation.projectId === projectId) || null;
  }
  function createOrReuse(input) {
    const existing = findByClientRequest(input.projectId, input.clientRequestKey);
    if (existing) {
      if (existing.planDigest !== input.planDigest) return { ok: false, error: 'client_request_conflict' };
      return { ok: true, reused: true, operation: existing };
    }
    const operation = {
      id: randomUUID(),
      status: 'applying',
      createdAt: Date.now(),
      createdAgentIds: [],
      attachedAgentIds: [],
      errorCode: null,
      ...input,
    };
    operations.set(operation.id, operation);
    save();
    return { ok: true, reused: false, operation };
  }
  function update(id, patch) {
    const operation = get(id);
    if (!operation) return null;
    Object.assign(operation, patch, { updatedAt: Date.now() });
    save();
    return operation;
  }
  function updateIntent(id, intentId, patch) {
    const operation = get(id);
    const intent = operation?.provisioningIntents?.find(value => value.intentId === intentId);
    if (!intent) return null;
    Object.assign(intent, patch);
    return update(id, {});
  }
  return { get, findByClientRequest, findLatestByProject, createOrReuse, update, updateIntent, list: () => [...operations.values()] };
}
