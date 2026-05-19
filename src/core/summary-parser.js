/**
 * summary-parser.js — Parse project summary section and score from synthesis text.
 */

/**
 * Extract the "项目小结" / "Project Summary" section from synthesis markdown.
 * Returns only the summary section content, or null if not found.
 * @param {string} synthesis
 * @returns {string | null}
 */
export function extractSummarySection(synthesis) {
  if (!synthesis) return null;
  // Match "## 项目小结" or "## Project Summary" heading and capture everything after it.
  // Use greedy match to string end, then strip any trailing same-level heading if present.
  const match = synthesis.match(/^##\s*(?:项目小结|Project Summary)[^\n]*\n([\s\S]+)/mi);
  if (!match) return null;
  // If another ## heading follows, truncate there
  let content = match[1].replace(/\n##\s[^#][\s\S]*$/, '');
  content = content.trim();
  return content || null;
}

/**
 * Extract project score (1-10) from synthesis text.
 * Handles Chinese/English formats, strips Markdown bold/code formatting before matching.
 * @param {string} synthesis
 * @returns {number | null}
 */
export function extractSummaryScore(synthesis) {
  if (!synthesis) return null;
  // Strip common markdown formatting that might wrap the score
  const cleaned = synthesis.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
  // Try multiple patterns in priority order
  const patterns = [
    /(?:评分|Score)\s*[:：]\s*(\d+)\s*\/\s*10/i,
    /(\d+)\s*\/\s*10\s*(?:分|points?)?/i,
    /(?:评分|Score|Rating)\s*[:：]\s*(\d+)\s*(?:out of|\/)\s*10/i,
  ];
  for (const pat of patterns) {
    const match = cleaned.match(pat);
    if (match) {
      const score = parseInt(match[1], 10);
      return Math.min(10, Math.max(1, score));
    }
  }
  return null;
}
