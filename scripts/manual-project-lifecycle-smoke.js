#!/usr/bin/env node

const DEFAULT_API_URL = 'http://127.0.0.1:4400';
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_DISPATCH_INTERVAL_MS = 30_000;
const DEFAULT_PO_AGENT = 'xiaok-po';
const DEFAULT_MEMBERS = ['xiaok-worker'];

export function parseArgs(argv = []) {
  const options = {
    apiUrl: process.env.KSWARM_API || DEFAULT_API_URL,
    timeoutMs: Number(process.env.KSWARM_MANUAL_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    pollMs: Number(process.env.KSWARM_MANUAL_SMOKE_POLL_MS || DEFAULT_POLL_MS),
    dispatchIntervalMs: Number(process.env.KSWARM_MANUAL_SMOKE_DISPATCH_INTERVAL_MS || DEFAULT_DISPATCH_INTERVAL_MS),
    poAgent: process.env.KSWARM_MANUAL_SMOKE_PO || DEFAULT_PO_AGENT,
    members: process.env.KSWARM_MANUAL_SMOKE_MEMBERS
      ? process.env.KSWARM_MANUAL_SMOKE_MEMBERS.split(',').map(value => value.trim()).filter(Boolean)
      : DEFAULT_MEMBERS.slice(),
    name: process.env.KSWARM_MANUAL_SMOKE_NAME || '',
    goal: process.env.KSWARM_MANUAL_SMOKE_GOAL || '',
    yes: false,
    expectHtml: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-html') options.expectHtml = false;
    else if (arg === '--api-url') options.apiUrl = requiredValue(argv, ++i, arg);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(requiredValue(argv, ++i, arg));
    else if (arg === '--poll-ms') options.pollMs = Number(requiredValue(argv, ++i, arg));
    else if (arg === '--dispatch-interval-ms') options.dispatchIntervalMs = Number(requiredValue(argv, ++i, arg));
    else if (arg === '--po-agent') options.poAgent = requiredValue(argv, ++i, arg);
    else if (arg === '--member') options.members.push(requiredValue(argv, ++i, arg));
    else if (arg === '--members') options.members = requiredValue(argv, ++i, arg).split(',').map(value => value.trim()).filter(Boolean);
    else if (arg === '--name') options.name = requiredValue(argv, ++i, arg);
    else if (arg === '--goal') options.goal = requiredValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeout must be a positive number');
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) throw new Error('poll interval must be a positive number');
  if (!Number.isFinite(options.dispatchIntervalMs) || options.dispatchIntervalMs <= 0) {
    throw new Error('dispatch interval must be a positive number');
  }
  options.apiUrl = options.apiUrl.replace(/\/+$/, '');
  options.members = [...new Set(options.members.filter(member => member && member !== options.poAgent))];
  return options;
}

export function buildProjectPayload(options = {}) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const poAgent = options.poAgent || DEFAULT_PO_AGENT;
  const members = Array.isArray(options.members) && options.members.length > 0
    ? options.members.filter(member => member !== poAgent)
    : DEFAULT_MEMBERS.filter(member => member !== poAgent);
  return {
    name: options.name || `KSwarm manual lifecycle smoke ${stamp}`,
    goal: options.goal || [
      '手工端到端冒烟验收：请生成一份简短中文 report renderer HTML 报告。',
      '报告主题为 KSwarm 可靠性验证，基于题目中给出的事实即可，不需要联网。',
      '必须覆盖：执行摘要、已验证链路、风险与下一步建议，并输出最终 HTML 报告。',
    ].join('\n'),
    requirements: [
      '这是人工触发的慢速 smoke，不要扩展范围。',
      '优先少任务、快完成，但必须经历 plan、approve、dispatch、worker submit、PO review、deliver。',
      '最终用户可见交付物必须包含 HTML 报告。',
    ].join('\n'),
    poAgent,
    members,
    enableSummary: true,
    agentSelection: {
      poAgent: { agentId: poAgent, source: 'default_seed' },
      members: members.map(agentId => ({ agentId, source: 'default_seed' })),
    },
  };
}

export function summarizeDetail(detail = {}) {
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const counts = {};
  for (const task of tasks) counts[task.status || 'unknown'] = (counts[task.status || 'unknown'] || 0) + 1;
  return {
    project: detail.project?.status || 'unknown',
    plan: Boolean(detail.plan || detail.project?.plan),
    tasks: counts,
    intervention: detail.projectIntervention?.primaryAction?.strategy || detail.projectIntervention?.reason || null,
  };
}

export function isDeliveredWithExpectedArtifacts(detail = {}, delivery = {}, { expectHtml = true } = {}) {
  if (detail.project?.status !== 'delivered') return false;
  if (!delivery.ok || !Array.isArray(delivery.manifest?.artifacts)) return false;
  if (!expectHtml) return true;
  return delivery.manifest.artifacts.some(artifact => {
    const text = `${artifact.filename || ''}\n${artifact.type || ''}\n${artifact.mimeType || ''}`;
    return /\.html?$/i.test(text) || /text\/html|html/i.test(text);
  });
}

export function shouldApprove(detail = {}) {
  return Boolean(
    (detail.plan || detail.project?.plan) &&
    ['created', 'planning'].includes(detail.project?.status)
  );
}

export async function runManualProjectLifecycleSmoke(options = {}, io = console) {
  if (options.help || !options.yes) {
    io.log(helpText());
    if (!options.yes && !options.help) {
      throw new Error('manual smoke requires --yes because it creates a real KSwarm project and consumes agent runtime');
    }
    return null;
  }

  const deadline = Date.now() + options.timeoutMs;
  const projectPayload = buildProjectPayload(options);
  let lastDispatchAt = 0;
  let lastPrintedSummary = '';

  io.log(`[smoke] API: ${options.apiUrl}`);
  await assertHealthy(options.apiUrl);
  await assertRequiredParticipantsOnline(options.apiUrl, [projectPayload.poAgent, ...projectPayload.members]);

  const created = await postJson(options.apiUrl, '/projects', projectPayload);
  const projectId = created.project?.id;
  if (!created.ok || !projectId) throw new Error(`project creation failed: ${JSON.stringify(created)}`);
  io.log(`[smoke] created project ${projectId}`);

  while (Date.now() < deadline) {
    const detail = await getJson(options.apiUrl, `/projects/${projectId}`);
    const summary = JSON.stringify(summarizeDetail(detail));
    if (summary !== lastPrintedSummary) {
      io.log(`[smoke] ${new Date().toISOString()} ${summary}`);
      lastPrintedSummary = summary;
    }

    if (detail.project?.status === 'delivered') {
      const delivery = await getJson(options.apiUrl, `/projects/${projectId}/delivery`);
      if (!isDeliveredWithExpectedArtifacts(detail, delivery, options)) {
        throw new Error(`project delivered without expected artifacts: ${JSON.stringify(delivery)}`);
      }
      io.log(`[smoke] delivered ${projectId}`);
      io.log(`[smoke] delivery artifacts: ${delivery.manifest.artifacts.map(a => a.filename).join(', ')}`);
      return { ok: true, projectId, delivery };
    }

    if (detail.project?.preparation?.state === 'blocked') {
      await postJson(options.apiUrl, `/projects/${projectId}/prepare`, { forceProbe: true });
    } else if (shouldApprove(detail)) {
      await postJson(options.apiUrl, `/projects/${projectId}/approve`, {});
      io.log('[smoke] approved project');
    } else if (detail.projectIntervention?.primaryAction?.id === 'continue_project') {
      await continueProject(options.apiUrl, projectId, detail);
      io.log(`[smoke] continue_project: ${detail.projectIntervention.primaryAction.strategy}`);
    } else if (shouldSynthesize(detail)) {
      await synthesizeProject(options.apiUrl, projectId, projectPayload.poAgent);
      io.log('[smoke] synthesized project');
    } else if (shouldDispatch(detail) && Date.now() - lastDispatchAt >= options.dispatchIntervalMs) {
      await postJson(options.apiUrl, `/projects/${projectId}/dispatch`, { fromAgent: projectPayload.poAgent });
      lastDispatchAt = Date.now();
      io.log('[smoke] requested dispatch');
    }

    await sleep(options.pollMs);
  }

  throw new Error(`manual smoke timed out after ${options.timeoutMs}ms`);
}

function shouldDispatch(detail = {}) {
  if (detail.project?.status !== 'active') return false;
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  if (tasks.some(task => ['dispatched', 'accepted', 'in_progress', 'submitted'].includes(task.status))) return false;
  return tasks.some(task => task.status === 'pending' && (!Array.isArray(task.unresolvedDependencies) || task.unresolvedDependencies.length === 0));
}

function shouldSynthesize(detail = {}) {
  if (detail.project?.status !== 'active') return false;
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  if (tasks.length === 0) return false;
  return tasks.every(task => task.status === 'done');
}

async function continueProject(apiUrl, projectId, detail) {
  const taskId = detail.projectIntervention?.primaryTaskId;
  const task = (detail.tasks || []).find(item => item.id === taskId);
  return await postJson(apiUrl, `/projects/${projectId}/continue`, {
    expectedPrimaryTaskId: taskId,
    expectedTaskUpdatedAt: task?.updatedAt || detail.projectIntervention?.primaryAction?.taskUpdatedAt || Date.now(),
    idempotencyKey: `manual-smoke-${projectId}-${taskId || 'project'}-${Date.now()}`,
  });
}

async function synthesizeProject(apiUrl, projectId, poAgent) {
  return await postJson(apiUrl, `/projects/${projectId}/synthesize`, {
    fromAgent: poAgent,
    synthesis: [
      '# 手工端到端冒烟验收总结',
      '',
      '项目任务已完成，产物已通过 PO review。此 synthesis 由 manual smoke 脚本在所有任务 done 后提交，用于完成 delivered 状态验证。',
    ].join('\n'),
  });
}

async function assertHealthy(apiUrl) {
  const health = await getJson(apiUrl, '/health');
  if (!health.ok || !health.brokerConnected) {
    throw new Error(`KSwarm is not healthy or broker is disconnected: ${JSON.stringify(health)}`);
  }
}

async function assertRequiredParticipantsOnline(apiUrl, participantIds) {
  const data = await getJson(apiUrl, '/participants');
  const participants = data.participants || data || [];
  const online = new Set(participants.map(p => p.participantId || p.id).filter(Boolean));
  const missing = participantIds.filter(id => !online.has(id));
  if (missing.length > 0) {
    throw new Error(`required desktop runtime participants are offline: ${missing.join(', ')}`);
  }
}

async function getJson(apiUrl, path) {
  const res = await fetchResponse(`${apiUrl}${path}`, { method: 'GET' }, 'GET', path);
  return await parseJsonResponse(res, 'GET', path);
}

async function postJson(apiUrl, path, body) {
  const res = await fetchResponse(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, 'POST', path);
  return await parseJsonResponse(res, 'POST', path);
}

async function fetchResponse(url, init, method, path) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = formatErrorCause(err);
    throw new Error(`${method} ${path} fetch failed for ${url}${cause ? `: ${cause}` : ''}`);
  }
}

async function parseJsonResponse(res, method, path) {
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function helpText() {
  return [
    'Manual KSwarm project lifecycle smoke.',
    '',
    'This is intentionally opt-in and slow. It creates a real project and consumes Desktop agent runtime.',
    '',
    'Usage:',
    '  npm run smoke:manual-project-lifecycle -- --yes',
    '',
    'Options:',
    '  --api-url URL                 Default: http://127.0.0.1:4400',
    '  --timeout-ms N                Default: 2700000',
    '  --poll-ms N                   Default: 10000',
    '  --dispatch-interval-ms N      Default: 30000',
    '  --po-agent ID                 Default: xiaok-po',
    '  --members ID1,ID2             Default: xiaok-worker',
    '  --member ID                   Add one member',
    '  --name TEXT                   Override project name',
    '  --goal TEXT                   Override project goal',
    '  --no-html                     Do not require an HTML delivery artifact',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runManualProjectLifecycleSmoke(parseArgs(process.argv.slice(2)))
    .catch(err => {
      console.error(`[smoke] failed: ${formatErrorForCli(err)}`);
      process.exitCode = 1;
    });
}

function formatErrorForCli(err) {
  const message = err?.message || String(err);
  const cause = formatErrorCause(err);
  return cause ? `${message}: ${cause}` : message;
}

function formatErrorCause(err) {
  const cause = err?.cause;
  if (!cause) return '';
  const details = [
    cause.name,
    cause.code,
    cause.errno,
    cause.syscall,
    cause.address,
    cause.port,
    cause.message,
  ].filter(Boolean);
  return details.join(' ');
}
