import {
  buildQualityPromptExcerpt,
  compileEffectiveQualityRuleSet,
  getBuiltinQualityKnowledgeDocuments,
  getBuiltinQualityPacks,
} from '../core/quality-rules.js';
import { extractQualityRulesFromKnowledge } from '../core/quality-rule-extractor.js';
import { validateQualityPatch } from '../core/quality-overlays.js';

export function handleQualityApiRequest({ method, path, query = {}, body = null, hub = null, overlayStore = null, now = Date.now() }) {
  if (!String(path || '').startsWith('/quality')) return { handled: false };

  const overlays = typeof overlayStore?.listOverlays === 'function' ? overlayStore.listOverlays() : [];

  if (path === '/quality/rules/effective' && method === 'GET') {
    if (query.projectId) {
      const project = hub?.getProject?.(query.projectId);
      if (!project) return response(404, { error: 'project_not_found' });
      const ruleSet = project.qualityRuleSet || compileEffectiveQualityRuleSet({
        goal: project.goal || '',
        requirements: project.requirements || '',
        overlays,
        now,
      });
      return response(200, {
        projectId: project.id,
        ruleSet,
        promptExcerpt: buildQualityPromptExcerpt(ruleSet, {
          role: query.role || 'po',
          budgetChars: Number(query.budgetChars) || 1200,
        }),
      });
    }

    const ruleSet = compileEffectiveQualityRuleSet({
      goal: query.goal || '',
      requirements: query.requirements || '',
      overlays,
      now,
    });
    return response(200, {
      ruleSet,
      promptExcerpt: buildQualityPromptExcerpt(ruleSet, {
        role: query.role || 'po',
        budgetChars: Number(query.budgetChars) || 1200,
      }),
    });
  }

  if (path === '/quality/resolve-project-request' && method === 'POST') {
    const ruleSet = compileEffectiveQualityRuleSet({
      goal: body?.goal || '',
      requirements: body?.requirements || '',
      overlays,
      now,
    });
    return response(200, {
      ok: true,
      matchedPacks: ruleSet.knowledgePacks.map(pack => pack.id),
      ruleSet,
      promptExcerpt: buildQualityPromptExcerpt(ruleSet, {
        role: body?.role || 'po',
        budgetChars: Number(body?.budgetChars) || 1200,
      }),
    });
  }

  if (path === '/quality/patches/validate' && method === 'POST') {
    const validation = validateQualityPatch(body?.patch || body);
    return response(validation.ok ? 200 : 400, validation);
  }

  if (path === '/quality/rules/extract' && method === 'POST') {
    const result = extractQualityRulesFromKnowledge({
      knowledgeId: body?.knowledgeId,
      title: body?.title,
      content: body?.content,
      target: body?.target || 'user_knowledge_overlay',
      appliesTo: body?.appliesTo,
      now,
    });
    return response(200, result);
  }

  if (path === '/quality/patches/apply' && method === 'POST') {
    if (typeof overlayStore?.applyPatch !== 'function') {
      return response(503, { ok: false, error: 'quality_overlay_store_unavailable' });
    }
    const result = overlayStore.applyPatch(body?.patch || body);
    return response(result.ok ? 200 : 400, result);
  }

  if (path === '/quality/knowledge' && method === 'GET') {
    const allOverlays = typeof overlayStore?.listOverlays === 'function' ? overlayStore.listOverlays() : [];
    return response(200, {
      knowledgeDocuments: getBuiltinQualityKnowledgeDocuments(),
      builtinPacks: getBuiltinQualityPacks(),
      userOverlays: allOverlays.filter(item => item.scope === 'user'),
      workspaceOverlays: allOverlays.filter(item => item.scope === 'workspace'),
      conflicts: [],
    });
  }

  return response(404, { error: 'not_found', path });
}

function response(status, body) {
  return { handled: true, status, body };
}
