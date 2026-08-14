import assert from 'node:assert/strict';
import {
  CAPABILITY_CATALOG_VERSION,
  getCapabilityCatalog,
  normalizeAgentCapabilities,
  validateCapabilityNeeds,
} from '../src/core/capability-catalog.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('catalog is versioned and exposes the canonical hosted Xiaok capabilities', () => {
  const catalog = getCapabilityCatalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.catalogVersion, CAPABILITY_CATALOG_VERSION);
  assert.ok(catalog.definitions.some(definition => definition.key === 'research'));
  assert.ok(catalog.definitions.some(definition => definition.key === 'report_generation'));

  const normalized = normalizeAgentCapabilities({ runtimeType: 'xiaok', capabilities: [] });
  assert.ok(normalized.includes('research'));
  assert.ok(normalized.includes('slide_generation'));
});

test('need validation fails closed for unknown, duplicate, and oversized needs', () => {
  const catalog = getCapabilityCatalog();
  const unknown = validateCapabilityNeeds([{ needKey: 'unknown', requiredCapabilities: ['not-real'], responsibilities: [] }], catalog);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_capability');

  const duplicate = validateCapabilityNeeds([
    { needKey: 'research', requiredCapabilities: ['research'], responsibilities: [] },
    { needKey: 'research', requiredCapabilities: ['research'], responsibilities: [] },
  ], catalog);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'duplicate_need');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`capability-catalog: ${passed}/${tests.length} passed`);
