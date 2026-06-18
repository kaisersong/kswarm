/**
 * KSwarm — schema.org JSON-LD adapter for HTML report artifacts.
 *
 * Pure functions, no IO. Used by semantic-html-renderer.js to inject
 * <script type="application/ld+json"> into the <head> of generated reports.
 *
 * See docs/design/2026-06-17-schema-jsonld-embedded-metadata-design-v2.1-final.md
 */

/**
 * Build schema.org JSON-LD payload for an HTML report.
 *
 * @param {Object} input
 * @param {string} [input.taskId] - KSwarm task id
 * @param {string} [input.title] - Report title
 * @param {string} [input.generatedAt] - ISO8601 timestamp; caller-supplied
 * @param {string} [input.projectId] - KSwarm project id
 * @param {string} [input.projectName] - Human-readable project name
 * @returns {string} Serialized JSON-LD with sorted keys (recursive).
 */
export function buildReportJsonLd({ taskId, title, generatedAt, projectId, projectName } = {}) {
  const payload = {
    '@context': 'http://schema.org/',
    '@type': 'Report',
  };

  if (projectId && taskId) {
    payload['@id'] = `https://xiaok.app/id/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/report`;
  }

  payload.name = title || 'Report';
  if (generatedAt) payload.dateCreated = generatedAt;
  payload.inLanguage = 'zh-CN';

  if (projectId) {
    payload.isPartOf = {
      '@type': 'CreativeWork',
      '@id': `https://xiaok.app/id/project/${encodeURIComponent(projectId)}`,
    };
    if (projectName) payload.isPartOf.name = projectName;
  }

  payload.creator = { '@type': 'Organization', name: 'xiaok' };
  payload.additionalProperty = [
    { '@type': 'PropertyValue', propertyID: 'https://xiaok.app/ns#metadataVersion', value: '1' },
  ];

  return stableStringify(payload);
}

/**
 * Escape JSON string for embedding inside <script type="application/ld+json">.
 * Prevents:
 *  - </script> early termination (case-insensitive)
 *  - U+2028 / U+2029 line/paragraph separator breaking ES5 parsers
 */
export function escapeJsonLdForHtml(jsonString) {
  return String(jsonString)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Recursive key-sorted JSON serialization.
 * Arrays preserve order; objects sort keys lexicographically.
 * Ensures byte-identical output for byte-identical input.
 */
function stableStringify(value, indent = 2) {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted = {};
      for (const k of Object.keys(val).sort()) sorted[k] = val[k];
      return sorted;
    }
    return val;
  }, indent);
}
