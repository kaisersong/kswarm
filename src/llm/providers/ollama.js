/**
 * Ollama local LLM provider
 *
 * Config:
 *   { provider: 'ollama', baseUrl?, model? }
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.1';

export function createOllamaProvider(config) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    maxTokens = 2048,
    temperature = 0.7,
  } = config;

  async function chat(messages, opts = {}) {
    // Ollama supports OpenAI-compatible /v1/chat/completions
    const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const body = {
      model: opts.model || model,
      messages,
      options: {
        num_predict: opts.maxTokens || maxTokens,
        temperature: opts.temperature ?? temperature,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage || null,
      model: data.model || model,
    };
  }

  return {
    type: 'ollama',
    model,
    chat,
    toString: () => `Ollama(${baseUrl}, ${model})`,
  };
}
