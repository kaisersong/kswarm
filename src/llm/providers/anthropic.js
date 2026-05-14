/**
 * Anthropic Claude LLM provider
 *
 * Config:
 *   { provider: 'anthropic', apiKey, model? }
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_VERSION = '2023-06-01';

export function createAnthropicProvider(config) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    maxTokens = 2048,
    temperature = 0.7,
  } = config;

  if (!apiKey) throw new Error('Anthropic provider requires apiKey');

  async function chat(messages, opts = {}) {
    const url = `${baseUrl.replace(/\/$/, '')}/messages`;

    // Convert OpenAI-style messages to Anthropic format
    let system = '';
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content;
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    const body = {
      model: opts.model || model,
      max_tokens: opts.maxTokens || maxTokens,
      temperature: opts.temperature ?? temperature,
      messages: anthropicMessages,
    };
    if (system) body.system = system;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.content?.map(b => b.text).join('') || '';
    return {
      content,
      usage: data.usage || null,
      model: data.model,
    };
  }

  return {
    type: 'anthropic',
    model,
    chat,
    toString: () => `Anthropic(${model})`,
  };
}
