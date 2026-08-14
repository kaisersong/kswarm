import { createHash } from 'node:crypto';

const CAPABILITIES = [
  'coding', 'testing', 'qa', 'design', 'planning', 'research', 'analysis',
  'source_research', 'web_research', 'writing', 'documentation', 'review',
  'product', 'requirements', 'architecture', 'system-design', 'engineering',
  'devops', 'deployment', 'data_analysis', 'report_generation',
  'presentation_generation', 'presentation_content', 'slide_generation',
];

export const CAPABILITY_DEFINITIONS = Object.freeze(CAPABILITIES.map(key => Object.freeze({ key })));
export const CAPABILITY_CATALOG_VERSION = createHash('sha256')
  .update(JSON.stringify({ schemaVersion: 1, definitions: CAPABILITY_DEFINITIONS }))
  .digest('hex');

const CAPABILITY_KEYS = new Set(CAPABILITIES);

export function getCapabilityCatalog() {
  return {
    schemaVersion: 1,
    catalogVersion: CAPABILITY_CATALOG_VERSION,
    definitions: CAPABILITY_DEFINITIONS.map(definition => ({ ...definition })),
  };
}

export function normalizeCapabilityList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => CAPABILITY_KEYS.has(value)))];
}

export function normalizeAgentCapabilities(agent = {}) {
  const explicit = normalizeCapabilityList(agent.capabilities || agent.taskCapabilities);
  if (agent.runtimeType === 'xiaok' && explicit.length === 0) return [...CAPABILITIES];
  return explicit;
}

export function validateCapabilityNeeds(needs, catalog = getCapabilityCatalog()) {
  if (!catalog || catalog.schemaVersion !== 1 || catalog.catalogVersion !== CAPABILITY_CATALOG_VERSION) {
    return { ok: false, error: 'stale_catalog' };
  }
  if (!Array.isArray(needs) || needs.length === 0 || needs.length > 6) {
    return { ok: false, error: 'invalid_need_count' };
  }
  const needKeys = new Set();
  const normalized = [];
  for (const need of needs) {
    const needKey = typeof need?.needKey === 'string' ? need.needKey.trim() : '';
    if (!needKey) return { ok: false, error: 'invalid_need' };
    if (needKeys.has(needKey)) return { ok: false, error: 'duplicate_need' };
    needKeys.add(needKey);
    const requiredCapabilities = normalizeCapabilityList(need.requiredCapabilities);
    if (!Array.isArray(need.requiredCapabilities) || requiredCapabilities.length !== need.requiredCapabilities.length) {
      return { ok: false, error: 'unknown_capability' };
    }
    if (requiredCapabilities.length === 0) return { ok: false, error: 'invalid_need' };
    normalized.push({
      needKey,
      requiredCapabilities,
      responsibilities: Array.isArray(need.responsibilities)
        ? need.responsibilities.map(value => String(value).trim()).filter(Boolean).slice(0, 8)
        : [],
      requiresIndependentReviewer: need.requiresIndependentReviewer === true,
    });
  }
  return { ok: true, needs: normalized };
}
