import { canonicalizeOutputType } from './output-types.js';
import { buildReportJsonLd, escapeJsonLdForHtml } from './artifact-jsonld.js';

const REPORT_TEMPLATE_MARKER = 'data-template="kai-report-creator"';

export function hasRequiredOutputType(requiredOutputs = [], type) {
  const expected = canonicalizeOutputType(type);
  if (!expected) return false;
  return normalizeRequiredOutputs(requiredOutputs).some(output => output.type === expected && output.enforcement !== 'soft');
}

export function buildSemanticOutputArtifacts({
  taskId = 'task',
  title = 'Report',
  artifactContent = '',
  requiredOutputs = [],
  generatedAt = new Date().toISOString(),
  projectId,
  projectName,
} = {}) {
  const artifacts = [];
  if (hasRequiredOutputType(requiredOutputs, 'report_html')) {
    artifacts.push({
      filename: `${taskId}-report.html`,
      content: buildReportHtmlFromMarkdown({ title, markdown: artifactContent, generatedAt, taskId, projectId, projectName }),
      previewable: true,
      mimeType: 'text/html',
      semanticOutput: 'report_html',
    });
  }
  return artifacts;
}

export function buildReportHtmlFromMarkdown({
  title = 'Report',
  markdown = '',
  generatedAt = new Date().toISOString(),
  taskId,
  projectId,
  projectName,
} = {}) {
  const cleanTitle = sanitizeUserFacingDeliverableTitle(title);
  const cleanMarkdown = sanitizeUserFacingDeliverableMarkdown(markdown);
  const body = renderMarkdownSubset(cleanMarkdown);
  const jsonLd = buildReportJsonLd({
    taskId,
    title: cleanTitle,
    generatedAt,
    projectId,
    projectName,
  });
  const jsonLdTag = `    <script type="application/ld+json">${escapeJsonLdForHtml(jsonLd)}</script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(cleanTitle)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fa; color: #1f2933; }
    main { max-width: 960px; margin: 0 auto; padding: 48px 40px 72px; background: #fff; min-height: 100vh; }
    h1 { font-size: 34px; line-height: 1.2; margin: 0 0 20px; }
    h2 { font-size: 24px; margin: 34px 0 14px; border-bottom: 1px solid #d7dce2; padding-bottom: 8px; }
    h3 { font-size: 18px; margin: 26px 0 10px; }
    p, li { font-size: 15px; line-height: 1.75; }
    ul { padding-left: 22px; }
    .meta { color: #697586; font-size: 13px; margin-bottom: 28px; }
    table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px; }
    th, td { border: 1px solid #d7dce2; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f0f3f7; }
    code { background: #eef2f6; padding: 2px 5px; border-radius: 4px; }
  </style>
${jsonLdTag}
</head>
<body>
  <main ${REPORT_TEMPLATE_MARKER}>
    <div class="meta">Generated at ${escapeHtml(generatedAt)}</div>
${body}
  </main>
</body>
</html>`;
}

export function sanitizeUserFacingDeliverableTitle(title = '') {
  return stripInternalMarkers(String(title || 'Report')).trim() || 'Report';
}

export function sanitizeUserFacingDeliverableMarkdown(markdown = '') {
  const strippedSections = stripInternalProcessSections(String(markdown || ''));
  return strippedSections
    .split(/\r?\n/)
    .map(line => stripInternalMarkers(line).replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripInternalProcessSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const kept = [];
  let skippedHeadingLevel = null;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      if (skippedHeadingLevel !== null && level <= skippedHeadingLevel) {
        skippedHeadingLevel = null;
      }
      if (skippedHeadingLevel === null && isInternalProcessHeading(heading[2])) {
        skippedHeadingLevel = level;
        continue;
      }
    }
    if (skippedHeadingLevel !== null) continue;
    kept.push(line);
  }

  return kept.join('\n');
}

function isInternalProcessHeading(text = '') {
  const normalized = stripInternalMarkers(text)
    .replace(/\s+/g, '')
    .toLowerCase();
  return [
    '评审回应与修订说明',
    '评审回应',
    '修订说明',
    '修订总览',
    'reviewresponse',
    'reviewresponses',
    'revisionnotes',
    'changelog',
  ].includes(normalized);
}

function stripInternalMarkers(value = '') {
  return String(value || '')
    .replace(/[（(]\s*(?:第?[一二三四五六七八九十\d]+轮)?\s*修订定稿\s*[)）]/gi, '')
    .replace(/[（(]\s*第?[一二三四五六七八九十\d]+轮\s*修订\s*[)）]/gi, '')
    .replace(/[（(]\s*修订版\s*[)）]/gi, '')
    .replace(/[（(]\s*revision\s*(?:version|draft|final)?\s*[)）]/gi, '')
    .replace(/【\s*新增\s*】/g, '')
    .replace(/\[\s*新增\s*\]/gi, '')
    .replace(/【\s*修订\s*】/g, '')
    .replace(/\[\s*修订\s*\]/gi, '');
}

function normalizeRequiredOutputs(outputs = []) {
  return (Array.isArray(outputs) ? outputs : [])
    .map(output => {
      if (typeof output === 'string') return { type: output, enforcement: 'hard' };
      return {
        type: output?.type || output?.format || output?.kind || '',
        enforcement: output?.enforcement || 'hard',
      };
    })
    .map(output => ({
      type: canonicalizeOutputType(output.type),
      enforcement: String(output.enforcement || 'hard').trim().toLowerCase(),
    }))
    .filter(output => output.type);
}

function renderMarkdownSubset(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  const closeList = () => {
    if (!inList) return;
    html.push('    </ul>');
    inList = false;
  };
  const flushTable = () => {
    if (!inTable) return;
    html.push(renderTable(tableRows));
    tableRows = [];
    inTable = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      flushTable();
      continue;
    }

    if (isTableLine(line)) {
      closeList();
      inTable = true;
      tableRows.push(line);
      continue;
    }

    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push(`    <h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      if (!inList) {
        html.push('    <ul>');
        inList = true;
      }
      html.push(`      <li>${renderInline(listItem[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`    <p>${renderInline(line)}</p>`);
  }

  closeList();
  flushTable();
  return html.join('\n') || '    <p>No content.</p>';
}

function isTableLine(line) {
  return line.startsWith('|') && line.endsWith('|') && line.split('|').length > 2;
}

function renderTable(rows) {
  const normalized = rows
    .filter(row => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(row))
    .map(row => row.slice(1, -1).split('|').map(cell => renderInline(cell.trim())));
  if (normalized.length === 0) return '';
  const [head, ...body] = normalized;
  return [
    '    <table>',
    '      <thead><tr>' + head.map(cell => `<th>${cell}</th>`).join('') + '</tr></thead>',
    '      <tbody>',
    ...body.map(row => '        <tr>' + row.map(cell => `<td>${cell}</td>`).join('') + '</tr>'),
    '      </tbody>',
    '    </table>',
  ].join('\n');
}

function renderInline(value = '') {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
