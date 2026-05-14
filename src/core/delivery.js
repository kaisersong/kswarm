/**
 * KSwarm — Delivery Aggregation
 *
 * When PO delivers a project, aggregate all task artifacts into a structured delivery package.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

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
