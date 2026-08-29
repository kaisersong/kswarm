export function buildKimiCliArgs(prompt, model = '') {
  return [
    '--prompt', String(prompt || ''),
    '--output-format', 'text',
    ...(String(model || '').trim() ? ['--model', String(model).trim()] : []),
  ];
}
