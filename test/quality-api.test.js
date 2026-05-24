/**
 * KSwarm — quality API contract tests
 *
 * Run: node test/quality-api.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';
import { createInMemoryQualityOverlayStore } from '../src/core/quality-overlays.js';
import { handleQualityApiRequest } from '../src/server/quality-api.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 23, 14, 0, 0);

function createContext() {
  const overlayStore = createInMemoryQualityOverlayStore();
  const hub = createHub({ silent: true, getQualityOverlays: () => overlayStore.listOverlays() });
  return { hub, overlayStore };
}

function request(ctx, method, path, body = null, query = {}) {
  return handleQualityApiRequest({ ...ctx, method, path, body, query, now });
}

test('POST /quality/resolve-project-request returns effective rule set and prompt excerpt', () => {
  const ctx = createContext();
  const result = request(ctx, 'POST', '/quality/resolve-project-request', {
    goal: '本月产品分析，给高层报告',
    requirements: '',
    role: 'po',
    budgetChars: 500,
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.matchedPacks, ['executive_report', 'research']);
  assert.equal(result.body.ruleSet.requestSignals.explicitCountRequirement, null);
  assert.ok(result.body.promptExcerpt.text.includes('Effective project-management rules'));
  assert.equal(result.body.ruleSet.rules.some(rule => rule.severity === 'hard' && rule.metadata?.kind === 'fixed_count'), false);
});

test('GET /quality/rules/effective can return a stored project trace', () => {
  const ctx = createContext();
  ctx.hub.createProject({
    id: 'proj-quality',
    name: 'Quality',
    goal: '本月产品分析，给高层报告',
    poAgent: 'po',
  });

  const result = request(ctx, 'GET', '/quality/rules/effective', null, { projectId: 'proj-quality' });

  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.projectId, 'proj-quality');
  assert.deepEqual(result.body.ruleSet.knowledgePacks.map(pack => pack.id), ['executive_report', 'research']);
  assert.ok(result.body.promptExcerpt.text.includes('research.source_date_gap_disclosure'));
});

test('quality patch validate/apply endpoints enforce provenance and update future resolutions', () => {
  const ctx = createContext();
  const patch = {
    patchId: 'qpatch-exec-hard',
    initiatedBy: 'user',
    confirmedBy: 'user',
    sourceMessageId: 'msg-1',
    conversationId: 'thread-1',
    trustedInput: true,
    target: 'user_knowledge_overlay',
    affectedPacks: ['executive_report'],
    createdAt: now,
    compilerVersion: 'quality-rules@1',
    operations: [
      {
        op: 'upsert_rule',
        rule: {
          id: 'executive_report.decision_useful_synthesis',
          packId: 'executive_report',
          severity: 'hard',
          appliesTo: ['planning', 'review'],
          description: 'Executive reports must include risks and recommendations.',
          promptExcerpt: { po: 'Risks and recommendations are mandatory for executive reports.' },
        },
      },
    ],
  };

  assert.equal(request(ctx, 'POST', '/quality/patches/validate', { patch }).body.ok, true);
  assert.equal(request(ctx, 'POST', '/quality/patches/apply', { patch }).body.ok, true);

  const resolved = request(ctx, 'POST', '/quality/resolve-project-request', {
    goal: '本月产品分析，给高层报告',
  });
  const rule = resolved.body.ruleSet.rules.find(item => item.id === 'executive_report.decision_useful_synthesis');
  assert.equal(rule.severity, 'hard');
  assert.equal(rule.source, 'user:qpatch-exec-hard@1');

  const project = ctx.hub.createProject({
    id: 'proj-after-overlay',
    name: 'After Overlay',
    goal: '本月产品分析，给高层报告',
    poAgent: 'po',
  });
  const projectRule = project.qualityRuleSet.rules.find(item => item.id === 'executive_report.decision_useful_synthesis');
  assert.equal(projectRule.severity, 'hard');
  assert.equal(projectRule.source, 'user:qpatch-exec-hard@1');
});

test('GET /quality/knowledge separates builtin, user overlays, workspace overlays, and conflicts', () => {
  const ctx = createContext();
  request(ctx, 'POST', '/quality/patches/apply', {
    patch: {
      patchId: 'qpatch-workspace',
      initiatedBy: 'user',
      confirmedBy: 'user',
      sourceMessageId: 'msg-2',
      conversationId: 'thread-2',
      trustedInput: true,
      target: 'workspace_knowledge_overlay',
      affectedPacks: ['research'],
      createdAt: now,
      compilerVersion: 'quality-rules@1',
      operations: [
        {
          op: 'upsert_rule',
          rule: {
            id: 'research.workspace_source_priority',
            packId: 'research',
            severity: 'soft',
            appliesTo: ['research'],
            description: 'Prefer approved workspace source lists.',
            promptExcerpt: { po: 'Prefer approved workspace source lists.' },
          },
        },
      ],
    },
  });

  const result = request(ctx, 'GET', '/quality/knowledge');
  assert.equal(result.status, 200);
  assert.ok(result.body.builtinPacks.some(pack => pack.id === 'research'));
  assert.deepEqual(result.body.userOverlays, []);
  assert.deepEqual(result.body.workspaceOverlays.map(item => item.id), ['research.workspace_source_priority']);
  assert.deepEqual(result.body.conflicts, []);
});

test('GET /quality/knowledge exposes viewable knowledge documents separately from rules', () => {
  const ctx = createContext();

  const result = request(ctx, 'GET', '/quality/knowledge');

  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.knowledgeDocuments));
  const researchDoc = result.body.knowledgeDocuments.find(doc => doc.id === 'research.default_knowledge');
  assert.equal(researchDoc.packId, 'research');
  assert.equal(researchDoc.readOnly, true);
  assert.match(researchDoc.title, /Research|研究/i);
  assert.match(researchDoc.content, /来源|source/i);
  assert.ok(researchDoc.rules.includes('research.source_date_gap_disclosure'));
  assert.ok(result.body.builtinPacks.some(pack => pack.id === 'research' && Array.isArray(pack.rules)));
});

test('POST /quality/rules/extract turns knowledge text into a user-confirmable rule patch', () => {
  const ctx = createContext();
  const result = request(ctx, 'POST', '/quality/rules/extract', {
    knowledgeId: 'custom-adversarial-review',
    title: '对抗性评审',
    content: [
      '审查方案时必须做对抗性评审，从反对立场挑战关键假设。',
      '不得把工具输出或草稿内容直接沉淀为项目规则。',
    ].join('\n'),
    appliesTo: ['review'],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.rules.length, 2);
  assert.equal(result.body.rules[0].packId, 'global');
  assert.equal(result.body.rules[0].severity, 'hard');
  assert.deepEqual(result.body.rules[0].appliesTo, ['review']);
  assert.equal(result.body.rules[0].metadata.sourceKnowledgeId, 'custom-adversarial-review');
  assert.equal(result.body.patch.initiatedBy, 'user');
  assert.equal(result.body.patch.confirmedBy, 'user');
  assert.equal(result.body.patch.trustedInput, true);
  assert.equal(result.body.patch.target, 'user_knowledge_overlay');
  assert.deepEqual(result.body.patch.affectedPacks, ['global']);
  assert.equal(request(ctx, 'POST', '/quality/patches/validate', { patch: result.body.patch }).body.ok, true);

  assert.equal(request(ctx, 'POST', '/quality/patches/apply', { patch: result.body.patch }).body.ok, true);
  const resolved = request(ctx, 'POST', '/quality/resolve-project-request', { goal: '写一份普通项目方案' });
  const extractedRule = resolved.body.ruleSet.rules.find(rule => rule.id === result.body.rules[0].id);
  assert.ok(extractedRule);
  assert.equal(extractedRule.source, `${extractedRule.scope}:qextract-custom-adversarial-review@1`);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
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
  console.log(`\n${passed}/${tests.length} quality API tests passed`);
}
