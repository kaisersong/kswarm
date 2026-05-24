const DEFAULT_APPLIES_TO = ['planning', 'review'];
const VALID_APPLIES_TO = new Set(['planning', 'execution', 'review', 'delivery', 'research', 'final_deliverable']);
const HARD_RULE_PATTERN = /(必须|不得|禁止|不能|不允许|\bmust\b|\brequired\b|\bnever\b|\bshall\b|\bdo not\b|\bcannot\b)/i;
const SOFT_RULE_PATTERN = /(应该|建议|优先|尽量|\bshould\b|\bprefer\b|\brecommend\b|\bideally\b)/i;

export function extractQualityRulesFromKnowledge({
  knowledgeId = 'manual-knowledge',
  title = 'Knowledge',
  content = '',
  target = 'user_knowledge_overlay',
  appliesTo = DEFAULT_APPLIES_TO,
  now = Date.now(),
} = {}) {
  const statements = splitKnowledgeStatements(content).filter(statement =>
    HARD_RULE_PATTERN.test(statement) || SOFT_RULE_PATTERN.test(statement),
  );
  const sourceSlug = slugify(knowledgeId || title) || stableHash(`${title}\n${content}`);
  const normalizedAppliesTo = normalizeAppliesTo(appliesTo);
  const rules = statements.map((statement, index) => {
    const severity = HARD_RULE_PATTERN.test(statement) ? 'hard' : 'soft';
    const id = `global.${sourceSlug}.${index + 1}.${stableHash(statement)}`;
    return {
      id,
      packId: 'global',
      severity,
      defaultSeverity: severity,
      appliesTo: [...normalizedAppliesTo],
      description: statement,
      promptExcerpt: {
        po: `Check this project rule: ${statement}`,
        worker: `Follow this project rule: ${statement}`,
      },
      enabled: true,
      metadata: {
        kind: 'extracted_rule',
        sourceKnowledgeId: knowledgeId,
        sourceKnowledgeTitle: title,
      },
    };
  });

  const patch = rules.length > 0 ? {
    patchId: `qextract-${sourceSlug}`,
    initiatedBy: 'user',
    confirmedBy: 'user',
    trustedInput: true,
    target,
    affectedPacks: ['global'],
    createdAt: new Date(now).toISOString(),
    compilerVersion: 'quality-rules@1',
    operations: rules.map(rule => ({
      op: 'upsert_rule',
      rule,
    })),
  } : null;

  return {
    ok: true,
    knowledgeId,
    title,
    rules,
    patch,
    warnings: rules.length > 0 ? [] : ['no_extractable_rule_candidates'],
  };
}

function splitKnowledgeStatements(content) {
  return String(content || '')
    .split(/[\n\r]+|(?<=[。！？!?;；])\s+/)
    .map(line => line.replace(/^[-*•\d.)、\s]+/, '').trim())
    .flatMap(line => line.split(/(?<=[。！？!?;；])\s*/))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 20);
}

function normalizeAppliesTo(appliesTo) {
  const values = Array.isArray(appliesTo) ? appliesTo : DEFAULT_APPLIES_TO;
  const normalized = values
    .map(value => String(value || '').trim())
    .filter(value => VALID_APPLIES_TO.has(value));
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_APPLIES_TO];
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
