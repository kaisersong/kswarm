/**
 * OpenAI-compatible LLM provider
 *
 * Works with: OpenAI, DeepSeek, Moonshot, Together, any OpenAI-compatible API
 *
 * Config:
 *   { provider: 'openai', apiKey, baseUrl?, model? }
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

export function createOpenAIProvider(config) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    maxTokens = 2048,
    temperature = 0.7,
  } = config;

  if (!apiKey) throw new Error('OpenAI provider requires apiKey');

  async function chat(messages, opts = {}) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: opts.model || model,
      messages,
      max_tokens: opts.maxTokens || maxTokens,
      temperature: opts.temperature ?? temperature,
    };

    if (opts.responseFormat) {
      body.response_format = opts.responseFormat;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage || null,
      model: data.model,
    };
  }

  return {
    type: 'openai',
    model,
    chat,
    toString: () => `OpenAI(${baseUrl}, ${model})`,
  };
}
