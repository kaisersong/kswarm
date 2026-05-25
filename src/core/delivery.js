/**
 * KSwarm — Delivery Aggregation
 *
 * When PO delivers a project, aggregate all task artifacts into a structured delivery package.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { basename, join, extname } from 'node:path';

/**
 * Aggregate project artifacts into a delivery package.
 * @param {string} projectWorkspace - Path to project workspace (e.g. ~/.kswarm/projects/<id>)
 * @param {Object} [projectMeta] - Optional project metadata { name, goal, poAgent, deliveredAt }
 * @returns {{ manifestPath: string, reportPath: string|null, files: string[] } | null}
 */
export function aggregateDelivery(projectWorkspace, projectMeta = {}) {
  const artifactsDir = join(projectWorkspace, 'artifacts');
  const deliveryDir = join(projectWorkspace, 'delivery');

  if (!existsSync(artifactsDir)) return null;

  const files = readdirSync(artifactsDir).filter(f => {
    const fp = join(artifactsDir, f);
    return statSync(fp).isFile();
  });

  if (files.length === 0) return null;

  // Create delivery directory
  mkdirSync(deliveryDir, { recursive: true });

  // Build manifest
  const manifest = {
    project: projectMeta.name || 'Unknown',
    goal: projectMeta.goal || '',
    deliveredAt: projectMeta.deliveredAt || Date.now(),
    deliveredBy: projectMeta.poAgent || '',
    artifacts: [],
  };

  const textContents = []; // For report concatenation

  for (const filename of files) {
    const srcPath = join(artifactsDir, filename);
    const stat = statSync(srcPath);
    const ext = extname(filename).toLowerCase();

    const entry = {
      filename,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      taskId: extractTaskId(filename),
      type: getArtifactType(ext),
    };
    manifest.artifacts.push(entry);

    // Copy to delivery dir
    copyFileSync(srcPath, join(deliveryDir, filename));

    // Collect text content for report
    if (['.md', '.txt', '.json'].includes(ext)) {
      try {
        const content = readFileSync(srcPath, 'utf-8');
        textContents.push({ filename, content });
      } catch { /* skip unreadable */ }
    }
  }

  // Write manifest
  const manifestPath = join(deliveryDir, 'delivery-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Generate concatenated report
  let reportPath = null;
  if (textContents.length > 0) {
    reportPath = join(deliveryDir, 'delivery-report.md');
    const reportLines = [
      `# Delivery Report: ${projectMeta.name || 'Project'}`,
      '',
      `> Generated at ${new Date(manifest.deliveredAt).toISOString()}`,
      '',
      `## Summary`,
      '',
      `- Total artifacts: ${files.length}`,
      `- Text artifacts merged: ${textContents.length}`,
      '',
      '---',
      '',
    ];

    for (const { filename, content } of textContents) {
      reportLines.push(`## ${filename}`, '', content, '', '---', '');
    }

    writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');
  }

  return {
    manifestPath,
    reportPath,
    files: files.map(f => join(deliveryDir, f)),
    manifest,
  };
}

export function selectUserFacingDeliveryTask(tasks = []) {
  const candidates = (Array.isArray(tasks) ? tasks : [])
    .filter(task => task?.status === 'done' && taskHasArtifacts(task));
  if (candidates.length === 0) return null;

  const strongFinalOutputs = candidates
    .map(task => ({ task, score: strongestFinalArtifactScore(task) }))
    .filter(({ score }) => score >= 80);
  if (strongFinalOutputs.length > 0) {
    const bestScore = Math.max(...strongFinalOutputs.map(({ score }) => score));
    return latestCompleted(strongFinalOutputs
      .filter(({ score }) => score === bestScore)
      .map(({ task }) => task));
  }

  const explicitFinal = candidates.filter(task => isFinalDeliverableTitle(task.title) && !isSummaryTitle(task.title));
  if (explicitFinal.length > 0) return latestCompleted(explicitFinal);

  const leafTasks = candidates.filter(task => !hasDoneDependent(task, tasks));
  const nonSummaryLeaf = leafTasks.filter(task => !isSummaryTitle(task.title));
  if (nonSummaryLeaf.length > 0) return latestCompleted(nonSummaryLeaf);

  const nonSummary = candidates.filter(task => !isSummaryTitle(task.title));
  if (nonSummary.length > 0) return latestCompleted(nonSummary);

  if (leafTasks.length > 0) return latestCompleted(leafTasks);
  return latestCompleted(candidates);
}

export function buildUserFacingDeliveryFiles({
  projectId = '',
  projectName = '',
  goal = '',
  artifacts = [],
  finalTask = null,
  deliveryDir = '',
} = {}) {
  const submittedArtifacts = [
    ...(Array.isArray(finalTask?.result?.artifacts) ? finalTask.result.artifacts : []),
    ...(Array.isArray(finalTask?.result?.artifactManifest) ? finalTask.result.artifactManifest : []),
  ].filter(artifact => artifact && artifact.filename);
  if (submittedArtifacts.length > 0) {
    return submittedArtifacts.map(artifact => toUserFacingFile({ projectId, projectName, goal, artifact, finalTask, deliveryDir }));
  }

  const taskRefs = new Set([finalTask?.id, finalTask?.localTaskId].filter(Boolean).map(String));
  const selected = taskRefs.size > 0
    ? artifacts.filter(artifact => taskRefs.has(String(artifact?.taskId || '')))
    : [];
  const files = selected.length > 0 ? selected : artifacts.slice(-1);

  return files
    .filter(artifact => artifact && artifact.filename)
    .map(artifact => toUserFacingFile({ projectId, projectName, goal, artifact, finalTask, deliveryDir }));
}

function toUserFacingFile({ projectId = '', projectName = '', goal = '', artifact = {}, finalTask = null, deliveryDir = '' } = {}) {
  const filename = String(artifact.filename);
  const formalFilename = buildFormalDeliveryFilename({ projectName, goal, filename, artifact, finalTask });
  if (deliveryDir && formalFilename && formalFilename !== filename) {
    ensureDeliveryAlias({ deliveryDir, sourceFilename: filename, targetFilename: formalFilename });
  }
  const displayFilename = formalFilename || filename;
  const usesDeliveryAlias = Boolean(deliveryDir && formalFilename && formalFilename !== filename && existsSync(join(deliveryDir, formalFilename)));
  return {
    name: displayFilename,
    filename: displayFilename,
    originalFilename: filename,
    type: artifact.type,
    mimeType: artifact.mimeType || getMimeType(filename, artifact.type),
    size: artifact.size,
    taskId: artifact.taskId || finalTask?.id || null,
    url: usesDeliveryAlias
      ? `/projects/${encodeURIComponent(projectId)}/delivery/${encodeURIComponent(displayFilename)}`
      : artifact.url || (projectId ? `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(filename)}` : undefined),
    path: usesDeliveryAlias ? `delivery/${displayFilename}` : artifact.relativePath || artifact.path || `artifacts/${filename}`,
  };
}

function buildFormalDeliveryFilename({ projectName = '', goal = '', filename = '', artifact = {}, finalTask = null } = {}) {
  const ext = extname(filename).toLowerCase();
  if (!ext) return '';
  const hasFormalContext = String(projectName || goal || '').trim();
  if (!hasFormalContext) return '';

  const base = chooseFormalDeliveryBase({ projectName, goal, artifact, finalTask });
  const safeBase = sanitizeFilenamePart(base);
  if (!safeBase) return '';
  return `${safeBase}${ext}`;
}

function chooseFormalDeliveryBase({ projectName = '', goal = '', artifact = {}, finalTask = null } = {}) {
  const project = String(projectName || '').trim();
  const target = project || extractReportNameFromGoal(goal) || String(finalTask?.title || '').trim() || '项目交付物';
  const isReport = isReportArtifact(artifact, finalTask);
  if (isReport && !/报告|report/i.test(target)) return `${target}报告`;
  return target;
}

function extractReportNameFromGoal(goal = '') {
  const text = String(goal || '').trim();
  const match = text.match(/(?:输出|生成|撰写|制作|创建)\s*([^，。,；;\n]+?报告)/);
  if (match) return match[1].trim();
  return text;
}

function isReportArtifact(artifact = {}, finalTask = null) {
  const text = [
    artifact.filename,
    artifact.type,
    artifact.mimeType,
    finalTask?.title,
  ].filter(Boolean).join(' ');
  return /report|报告|report_html|text\/html|\.html?$/i.test(text);
}

function sanitizeFilenamePart(value = '') {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function ensureDeliveryAlias({ deliveryDir = '', sourceFilename = '', targetFilename = '' } = {}) {
  if (!deliveryDir || !sourceFilename || !targetFilename || sourceFilename === targetFilename) return;
  const targetPath = join(deliveryDir, targetFilename);
  if (existsSync(targetPath)) return;

  const sourceCandidates = [
    join(deliveryDir, sourceFilename),
    join(deliveryDir, basename(sourceFilename)),
    join(deliveryDir, '..', 'artifacts', sourceFilename),
  ];
  const sourcePath = sourceCandidates.find(candidate => existsSync(candidate));
  if (!sourcePath) return;
  copyFileSync(sourcePath, targetPath);
}

function taskHasArtifacts(task = {}) {
  return getTaskArtifacts(task).length > 0;
}

function getTaskArtifacts(task = {}) {
  const result = task.result || {};
  return [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
  ].filter(artifact => artifact && artifact.filename);
}

function strongestFinalArtifactScore(task = {}) {
  return getTaskArtifacts(task).reduce((best, artifact) => Math.max(best, finalArtifactScore(artifact)), 0);
}

function finalArtifactScore(artifact = {}) {
  const text = [
    artifact.filename,
    artifact.path,
    artifact.relativePath,
    artifact.url,
    artifact.type,
    artifact.mimeType,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/report_html|slide_html|text\/html|\.html?\b/.test(text)) return 100;
  if (/pptx|presentation|\.(pptx|key)\b/.test(text)) return 90;
  if (/application\/pdf|\.pdf\b/.test(text)) return 85;
  return 0;
}

function isFinalDeliverableTitle(title = '') {
  return /最终|交付|定稿|final|deliverable|markdown|html|pptx|报告|report/i.test(String(title || ''));
}

function isSummaryTitle(title = '') {
  return /总结|复盘|小结|synthesis|summary|retrospective/i.test(String(title || ''));
}

function hasDoneDependent(task, tasks) {
  const taskRefs = new Set([task.id, task.localTaskId, task.title].filter(Boolean));
  return (Array.isArray(tasks) ? tasks : []).some(candidate => {
    if (!candidate || candidate.id === task.id || candidate.status !== 'done') return false;
    return (candidate.dependencies || []).some(dep => taskRefs.has(dep));
  });
}

function latestCompleted(tasks) {
  return [...tasks].sort((left, right) => latestTaskTimestamp(right) - latestTaskTimestamp(left))[0] || null;
}

function latestTaskTimestamp(task = {}) {
  return Number(task.completedAt || task.updatedAt || task.createdAt || 0);
}

/**
 * Extract task ID from artifact filename convention: <taskId>-report.md
 */
function extractTaskId(filename) {
  const match = filename.match(/^(.+?)-report\./);
  return match ? match[1] : null;
}

/**
 * Classify artifact by extension
 */
function getArtifactType(ext) {
  const types = {
    '.md': 'markdown', '.txt': 'text', '.json': 'data',
    '.html': 'html', '.pdf': 'document',
    '.png': 'image', '.jpg': 'image', '.svg': 'image',
    '.docx': 'document', '.xlsx': 'spreadsheet',
  };
  return types[ext] || 'binary';
}

function getMimeType(filename, type) {
  const ext = extname(filename).toLowerCase();
  const byExt = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  if (byExt[ext]) return byExt[ext];
  const byType = {
    markdown: 'text/markdown',
    text: 'text/plain',
    data: 'application/json',
    html: 'text/html',
    image: 'image/*',
    document: 'application/octet-stream',
  };
  return byType[type] || undefined;
}
