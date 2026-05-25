const OUTPUT_TYPE_ALIASES = new Map([
  ['html_report', 'report_html'],
  ['html-report', 'report_html'],
  ['report-html', 'report_html'],
  ['reporthtml', 'report_html'],
  ['htmlreport', 'report_html'],
]);

export function canonicalizeOutputType(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return OUTPUT_TYPE_ALIASES.get(normalized) || normalized;
}

export function normalizeOutputTypes(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map(value => canonicalizeOutputType(value))
    .filter(Boolean);
}
