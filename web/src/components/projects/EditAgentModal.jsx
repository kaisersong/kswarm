/**
 * EditAgentModal — edit an existing agent's configuration.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';

const PROVIDERS = [
  { value: '', label: '暂不配置' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'ollama', label: 'Ollama' },
];

export function EditAgentModal({ agent, onClose }) {
  const { updateAgent } = useKSwarm();
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState(agent.provider || '');
  const [model, setModel] = useState(agent.model || '');
  const [baseUrl, setBaseUrl] = useState(agent.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [instructions, setInstructions] = useState(agent.instructions || '');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await updateAgent(agent.id, {
        name: name.trim(),
        provider: provider || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        instructions: instructions || undefined,
      });
      onClose();
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="relative w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-300 bg-gray-50 shadow-xl p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-gray-900">编辑智能体</h2>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">名称</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">ID</label>
            <input type="text" value={agent.id} disabled className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">LLM 提供商</label>
            <select value={provider} onChange={e => setProvider(e.target.value)}
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500">
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          {provider && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-gray-500">模型</label>
                <input type="text" value={model} onChange={e => setModel(e.target.value)}
                  placeholder={provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o'}
                  className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
              </div>
              {(provider === 'openai' || provider === 'ollama') && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-medium text-gray-500">Base URL</label>
                  <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                    className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
                </div>
              )}
              {provider !== 'ollama' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-medium text-gray-500">API Key</label>
                  <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="留空则保持不变"
                    className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
                </div>
              )}
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">指令</label>
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="系统提示词..." rows={3}
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500 resize-none" />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-100">关闭</button>
            <button type="button" onClick={handleSave} disabled={!name.trim() || loading}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {loading ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
