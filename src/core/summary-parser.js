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

/**
 * Extract per-task scores from synthesis text.
 * Expected format: `- 任务标题 @执行者: X/10 — 一句话评价`
 * @param {string} synthesis
 * @returns {Array<{ title: string; agent: string; score: number; comment: string }> | null}
 */
export function extractTaskScores(synthesis) {
  if (!synthesis) return null;
  // Locate the "### 任务评分" or "### Task Scores" section
  const sectionMatch = synthesis.match(/^###\s*(?:任务评分|Task Scores)[^\n]*\n([\s\S]+)/mi);
  if (!sectionMatch) return null;
  // Truncate at next heading of same or higher level
  let section = sectionMatch[1].replace(/\n#{1,3}\s[^#][\s\S]*$/, '').trim();
  if (!section) return null;

  const results = [];
  // Strip markdown bold/code formatting
  const cleaned = section.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
  // Match each line: - title @agent: score/10 — comment
  const linePattern = /^-\s+(.+?)\s+@([^:：]+)[:：]\s*(\d+)\s*\/\s*10\s*[—\-–]\s*(.+)$/gm;
  let m;
  while ((m = linePattern.exec(cleaned)) !== null) {
    const score = parseInt(m[3], 10);
    results.push({
      title: m[1].trim(),
      agent: m[2].trim(),
      score: Math.min(10, Math.max(1, score)),
      comment: m[4].trim(),
    });
  }
  return results.length > 0 ? results : null;
}
