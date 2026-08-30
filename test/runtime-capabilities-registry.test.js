/**
 * Runtime capability registry — the single source of truth for CLI runtime
 * support (design §3; adversarial review point 2: the duplicate sets in
 * agent-runtime-selection and runtime-probe must be eliminated).
 *
 * Every consumer — selection, /runtimes catalog, agent create validation,
 * probe, auto-worker — must read this registry. No second allowlist.
 */
import assert from 'node:assert/strict';
import {
  RUNTIME_CAPABILITIES,
  getRuntimeCapability,
  isSupportedRuntimeType,
  listSupportedCliRuntimeTypes,
  supportsGenerationProbe,
  generationProbeArgv,
  runtimeCatalogEntry,
} from '../src/core/runtime-capabilities.js';
import { getKnownCLIs } from '../src/core/agent-store.js';
import { buildPiCliArgs } from '../src/core/pi-cli-harness.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('registry declares pi supported with the frozen harness id', () => {
  const pi = getRuntimeCapability('pi');
  assert.equal(pi.type, 'pi');
  assert.equal(pi.harnessId, 'pi-cli');
  assert.equal(pi.supported, true);
  assert.equal(pi.executable, 'pi');
  assert.equal(pi.sessionPolicy, 'no_session');
});

test('registry declares deepseek detected-but-unsupported until headless probe passes', () => {
  const deepseek = getRuntimeCapability('deepseek');
  assert.equal(deepseek.type, 'deepseek');
  assert.equal(deepseek.harnessId, 'deepseek-dsh');
  // design §9: no verified headless CLI evidence on this machine -> unsupported
  assert.equal(deepseek.supported, false);
  assert.equal(deepseek.unsupportedReason, 'deepseek_headless_not_verified');
});

test('selection support set comes from the registry, including pi and excluding deepseek', () => {
  const supported = listSupportedCliRuntimeTypes();
  assert.ok(supported.includes('pi'));
  assert.ok(!supported.includes('deepseek'));
  assert.ok(isSupportedRuntimeType('pi'));
  assert.ok(!isSupportedRuntimeType('deepseek'));
  // every registry-supported type must be selectable
  for (const type of supported) {
    assert.ok(getRuntimeCapability(type), `missing capability for ${type}`);
  }
});

test('generation probe set comes from the registry: pi probes, deepseek does not', () => {
  assert.equal(supportsGenerationProbe('pi'), true);
  assert.equal(supportsGenerationProbe('deepseek'), false);
  assert.equal(supportsGenerationProbe('claude'), true);
});

test('pi generation probe argv reuses the harness builder with a no-tool prompt', () => {
  const argv = generationProbeArgv('pi', '');
  assert.deepEqual(argv, buildPiCliArgs('Reply with exactly OK. Do not use tools or modify files.', ''));
});

test('catalog entry exposes detected/supported/callability/reasonCode shape', () => {
  const entry = runtimeCatalogEntry('pi', { detected: true, path: '/usr/local/bin/pi' });
  assert.deepEqual(Object.keys(entry).sort(),
    ['callability', 'detected', 'path', 'reasonCode', 'supported', 'type'].sort());
  assert.equal(entry.supported, true);
  assert.equal(entry.detected, true);
  assert.equal(entry.callability, 'unknown');

  const unsupported = runtimeCatalogEntry('deepseek', { detected: false, path: null });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.callability, 'unavailable');
  assert.equal(unsupported.reasonCode, 'deepseek_headless_not_verified');
});

test('registry covers every known CLI type — no runtime bypasses the single owner', () => {
  const knownTypes = new Set(getKnownCLIs().map((cli) => cli.type));
  for (const type of knownTypes) {
    assert.ok(getRuntimeCapability(type), `KNOWN_AGENT_CLIS type '${type}' missing from capability registry`);
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} runtime capability registry tests passed`);
}
