const COMPILER_VERSION = 'quality-rules@1';
const RULE_SET_VERSION = 1;

const BUILTIN_PACKS = [
  {
    id: 'executive_report',
    version: 1,
    source: 'builtin',
    knowledgeDocuments: [
      {
        id: 'executive_report.default_knowledge',
        title: 'Executive Report Default Knowledge',
        content: [
          'Executive-facing reports should be decision-useful, formal, and complete.',
          'The final artifact should expose implications, risks, assumptions, and recommended next actions.',
          'Do not include draft notes, internal review traces, revision logs, or process commentary in final deliverables.',
        ].join('\n'),
      },
    ],
    rules: [
      {
        id: 'executive_report.final_artifact_polish',
        defaultSeverity: 'hard',
        appliesTo: ['final_deliverable', 'review'],
        description: 'Executive-facing final artifacts must be formal, complete, and free of internal process traces.',
        promptExcerpt: {
          po: 'Final executive report must be formal and must not expose drafts, internal review notes, revision logs, or process traces.',
          worker: 'Produce a polished final report. Do not include internal review notes, revision logs, or process traces.',
        },
      },
      {
        id: 'executive_report.decision_useful_synthesis',
        defaultSeverity: 'soft',
        appliesTo: ['planning', 'review'],
        description: 'Executive reports should make implications, risks, and recommended decisions easy to scan.',
        promptExcerpt: {
          po: 'Plan for decision-useful synthesis: implications, risks, assumptions, and recommended next actions.',
          worker: 'Make the report decision-useful: implications, risks, assumptions, and next actions should be easy to scan.',
        },
      },
    ],
  },
  {
    id: 'research',
    version: 1,
    source: 'builtin',
    knowledgeDocuments: [
      {
        id: 'research.default_knowledge',
        title: 'Research Default Knowledge',
        content: [
          'Research work should make evidence legible.',
          'Recent or external-source claims should name the source, publication date or access date, and known evidence gaps.',
          'Short-window research should state the time window and coverage limits.',
        ].join('\n'),
      },
    ],
    rules: [
      {
        id: 'research.source_date_gap_disclosure',
        defaultSeverity: 'hard',
        appliesTo: ['research', 'review'],
        description: 'Recent or external-source research must cite source, date, and known evidence gaps.',
        promptExcerpt: {
          po: 'Recent/external-source research must cite source, date, and evidence gaps; do not accept unsupported public-info claims.',
          worker: 'For recent/external-source claims, include source, date, and evidence gaps. Say when evidence is missing.',
        },
      },
      {
        id: 'research.recent_scope_gap_disclosure',
        defaultSeverity: 'soft',
        appliesTo: ['planning', 'research'],
        description: 'Short-window research should explain its time window and coverage limits.',
        promptExcerpt: {
          po: 'For current-month or recent research, plan explicit time-window and coverage-gap disclosure.',
          worker: 'State the research time window and coverage limits when the request is recent or current-period.',
        },
      },
    ],
  },
];

export function getBuiltinQualityPacks() {
  return BUILTIN_PACKS.map(pack => ({
    id: pack.id,
    version: pack.version,
    source: pack.source,
    knowledgeDocuments: pack.knowledgeDocuments.map(doc => ({
      id: doc.id,
      packId: pack.id,
      title: doc.title,
      content: doc.content,
      source: pack.source,
      version: pack.version,
      readOnly: true,
      rules: pack.rules.map(rule => rule.id),
    })),
    rules: pack.rules.map(rule => ({
      ...rule,
      appliesTo: [...rule.appliesTo],
      promptExcerpt: { ...rule.promptExcerpt },
    })),
  }));
}

export function getBuiltinQualityKnowledgeDocuments() {
  return BUILTIN_PACKS.flatMap(pack =>
    pack.knowledgeDocuments.map(doc => ({
      id: doc.id,
      packId: pack.id,
      title: doc.title,
      content: doc.content,
      source: pack.source,
      version: pack.version,
      readOnly: true,
      rules: pack.rules.map(rule => rule.id),
    })),
  );
}

export function compileEffectiveQualityRuleSet({ goal = '', requirements = '', overlays = [], now = Date.now() } = {}) {
  const text = `${goal || ''}\n${requirements || ''}`;
  const requestSignals = resolveRequestSignals(text);
  const knowledgePacks = requestSignals.matchedPacks
    .map(packId => getBuiltinPack(packId))
    .filter(Boolean)
    .map(pack => ({ id: pack.id, version: pack.version, source: pack.source }));

  const rules = [];
  for (const pack of requestSignals.matchedPacks.map(packId => getBuiltinPack(packId)).filter(Boolean)) {
    for (const rule of pack.rules) {
      if (!ruleApplies(rule, requestSignals)) continue;
      rules.push(materializeBuiltinRule(pack, rule, rule.defaultSeverity));
    }
  }

  const overlayResult = applyOverlayRules(rules, overlays, requestSignals);

  if (requestSignals.explicitCountRequirement) {
    overlayResult.rules.push({
      id: 'research.explicit_count_requirement',
      packId: 'research',
      source: 'explicit:user_request',
      severity: 'hard',
      defaultSeverity: 'hard',
      appliesTo: ['planning', 'research', 'review'],
      description: `User explicitly requested at least ${requestSignals.explicitCountRequirement.count} items.`,
      promptExcerpt: {
        po: `User explicitly requested at least ${requestSignals.explicitCountRequirement.count} items; treat this as a hard planning/review gate.`,
        worker: `Include at least ${requestSignals.explicitCountRequirement.count} items because the user explicitly requested it.`,
      },
      metadata: { kind: 'fixed_count', ...requestSignals.explicitCountRequirement },
    });
  } else if (requestSignals.softCountPreference) {
    overlayResult.rules.push({
      id: 'research.count_preference',
      packId: 'research',
      source: 'explicit:user_request',
      severity: 'soft',
      defaultSeverity: 'soft',
      appliesTo: ['planning', 'research'],
      description: `User expressed a soft preference for about ${requestSignals.softCountPreference.count} items.`,
      promptExcerpt: {
        po: `User prefers around ${requestSignals.softCountPreference.count} items, but this is not a hard quality gate unless confirmed.`,
        worker: `Aim for around ${requestSignals.softCountPreference.count} items if evidence supports it; do not fabricate to hit the count.`,
      },
      metadata: { kind: 'count_preference', ...requestSignals.softCountPreference },
    });
  }

  if (requestSignals.explicitNoWebSearch) {
    overlayResult.rules.push({
      id: 'explicit.no_web_search',
      packId: 'explicit',
      source: 'explicit:user_request',
      severity: 'hard',
      defaultSeverity: 'hard',
      appliesTo: ['planning', 'research', 'execution'],
      description: 'User explicitly prohibited web search or network lookup.',
      promptExcerpt: {
        po: 'User explicitly prohibited web search. Plan from provided/existing materials and disclose evidence limits.',
        worker: 'Do not use web search or network lookup. Use provided/existing materials and disclose evidence limits.',
      },
      metadata: { kind: 'no_web_search' },
    });
  }

  return {
    compilerVersion: COMPILER_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    createdAt: new Date(now).toISOString(),
    knowledgePacks,
    requestSignals,
    rules: sortRules(dedupeRules(overlayResult.rules)),
    conflicts: overlayResult.conflicts,
  };
}

export function buildQualityPromptExcerpt(ruleSet, { role = 'po', budgetChars = 1200 } = {}) {
  const rules = Array.isArray(ruleSet?.rules) ? ruleSet.rules : [];
  const budget = Math.max(120, Number(budgetChars) || 1200);
  const header = `Effective project-management rules (${ruleSet?.compilerVersion || COMPILER_VERSION}):`;
  const lines = [header];
  const includedRuleIds = [];

  for (const rule of rules) {
    const line = formatRulePromptLine(rule, role);
    const nextText = [...lines, line].join('\n');
    if (nextText.length > budget) break;
    lines.push(line);
    includedRuleIds.push(rule.id);
  }

  const omittedCount = Math.max(0, rules.length - includedRuleIds.length);
  if (omittedCount > 0) {
    const omittedLine = `- ... ${omittedCount} rule(s) omitted by prompt budget.`;
    const nextText = [...lines, omittedLine].join('\n');
    if (nextText.length <= budget) lines.push(omittedLine);
  }

  return {
    role,
    text: lines.join('\n').slice(0, budget),
    includedRuleIds,
    omittedCount,
  };
}

export function appendQualityPlanningGuidance(planningGuidance = '', qualityPlanningGuidance = '') {
  const existing = String(planningGuidance || '').trim();
  const quality = String(qualityPlanningGuidance || '').trim();
  if (!existing) return quality;
  if (!quality) return existing;
  return `${existing}\n\n${quality}`;
}

function resolveRequestSignals(text) {
  const value = String(text || '');
  const explicitNoWebSearch = /(不要|禁止|无需|不)\s*(联网|上网|搜索|检索)|no\s+web|without\s+(web|internet)/i.test(value);
  const requiresRecentEvidence = !explicitNoWebSearch && /(本月|本周|近期|最近|最新|今年|current\s+month|this\s+month|latest|recent)/i.test(value);
  const executiveAudience = /(高层|管理层|高管|董事会|决策|老板|汇报|报告|executive|leadership|board|decision)/i.test(value);
  const researchIntent = /(产品|竞品|市场|行业|分析|研究|调研|评估|研判|洞察|公开信息|research|analysis|market|industry|product|competitive)/i.test(value);

  const matched = new Set();
  if (executiveAudience) matched.add('executive_report');
  if (researchIntent || requiresRecentEvidence) matched.add('research');

  const softCountPreference = parseSoftCountPreference(value);
  const explicitCountRequirement = softCountPreference ? null : parseExplicitCountRequirement(value);

  return {
    matchedPacks: [...matched].sort(),
    requiresRecentEvidence,
    executiveAudience,
    explicitCountRequirement,
    softCountPreference,
    explicitNoWebSearch,
  };
}

function parseExplicitCountRequirement(text) {
  const patterns = [
    /(?:至少|不少于|不低于)\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:条|个|项|份|篇|则|sources?|items?)/i,
    /(?:给我|列出|提供|整理|必须|需要)\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:条|个|项|份|篇|则|sources?|items?)/i,
    /(?:minimum\s+of|at\s+least)\s*([0-9]+)\s*(?:sources?|items?)?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = parseCount(match[1]);
    if (count) return { count, operator: 'at_least' };
  }
  return null;
}

function parseSoftCountPreference(text) {
  const patterns = [
    /(?:最好|尽量|希望|建议|可以|优先|尽可能)\s*(?:有|给|列|提供|整理)?\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:条|个|项|份|篇|则|sources?|items?)/i,
    /(?:prefer|ideally|if\s+possible)\s*([0-9]+)\s*(?:sources?|items?)?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = parseCount(match[1]);
    if (count) return { count };
  }
  return null;
}

function parseCount(value) {
  const raw = String(value || '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const numerals = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (raw === '十') return 10;
  const tenIndex = raw.indexOf('十');
  if (tenIndex >= 0) {
    const left = raw.slice(0, tenIndex);
    const right = raw.slice(tenIndex + 1);
    const tens = left ? numerals[left] || 0 : 1;
    const ones = right ? numerals[right] || 0 : 0;
    return tens * 10 + ones;
  }
  return numerals[raw] || null;
}

function getBuiltinPack(packId) {
  return BUILTIN_PACKS.find(pack => pack.id === packId) || null;
}

function ruleApplies(rule, signals) {
  if (rule.id === 'research.source_date_gap_disclosure') {
    return signals.requiresRecentEvidence || Boolean(signals.explicitCountRequirement);
  }
  if (rule.id === 'research.recent_scope_gap_disclosure') {
    return signals.requiresRecentEvidence;
  }
  return true;
}

function materializeBuiltinRule(pack, rule, severity) {
  return {
    id: rule.id,
    packId: pack.id,
    source: `${pack.source}:${pack.id}@${pack.version}`,
    severity,
    defaultSeverity: rule.defaultSeverity,
    appliesTo: [...rule.appliesTo],
    description: rule.description,
    promptExcerpt: { ...rule.promptExcerpt },
    metadata: { kind: 'builtin' },
  };
}

function applyOverlayRules(baseRules, overlays, signals) {
  const rules = [...baseRules];
  const conflicts = [];
  const sortedOverlays = Array.isArray(overlays)
    ? [...overlays].filter(rule => rule?.enabled !== false && overlayApplies(rule, signals)).sort(compareOverlayPriority)
    : [];

  for (const overlay of sortedOverlays) {
    const nextRule = materializeOverlayRule(overlay);
    const existingIndex = rules.findIndex(rule => rule.id === nextRule.id);
    if (existingIndex >= 0) {
      const existing = rules[existingIndex];
      if (existing.severity !== nextRule.severity) {
        conflicts.push({
          type: 'severity_conflict',
          ruleId: nextRule.id,
          sources: [existing.source, nextRule.source],
          resolution: `${nextRule.scope || 'user'}_override`,
          chosenSeverity: nextRule.severity,
          needsConfirmation: false,
        });
      }
      rules[existingIndex] = nextRule;
    } else {
      rules.push(nextRule);
    }
  }

  return { rules, conflicts };
}

function materializeOverlayRule(rule) {
  return {
    id: rule.id,
    packId: rule.packId,
    source: rule.source || `${rule.scope || 'user'}:${rule.patchId || 'overlay'}@1`,
    severity: rule.severity,
    defaultSeverity: rule.defaultSeverity || rule.severity,
    appliesTo: Array.isArray(rule.appliesTo) ? [...rule.appliesTo] : ['planning'],
    description: rule.description || '',
    promptExcerpt: { ...(rule.promptExcerpt || {}) },
    metadata: { ...(rule.metadata || {}), kind: rule.metadata?.kind || 'overlay' },
    scope: rule.scope || 'user',
  };
}

function overlayApplies(rule, signals) {
  if (rule.packId === 'global' || rule.packId === 'explicit') return true;
  return signals.matchedPacks.includes(rule.packId);
}

function compareOverlayPriority(left, right) {
  const priority = rule => rule.scope === 'user' ? 1 : 0;
  return priority(left) - priority(right) || String(left.id).localeCompare(String(right.id));
}

function dedupeRules(rules) {
  const seen = new Set();
  const deduped = [];
  for (const rule of rules) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    deduped.push(rule);
  }
  return deduped;
}

function sortRules(rules) {
  const severityOrder = severity => severity === 'hard' ? 0 : 1;
  return [...rules].sort((left, right) => {
    const severityDelta = severityOrder(left.severity) - severityOrder(right.severity);
    return severityDelta || left.id.localeCompare(right.id);
  });
}

function formatRulePromptLine(rule, role) {
  const prompt = rule.promptExcerpt?.[role] || rule.promptExcerpt?.po || rule.description;
  return `- [${rule.severity}] ${rule.id}: ${prompt}`;
}
