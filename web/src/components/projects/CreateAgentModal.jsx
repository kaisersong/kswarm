/**
 * CreateAgentModal — agent creation wizard.
 * For xiaok runtime, fetches models from kswarm's model catalog.
 */

import { useState, useEffect } from 'react';
import { X, Bot, Crown, Zap } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';

const AGENT_TYPES = [
  { id: 'worker', label: '执行者', desc: '编码、测试、设计、写作', icon: Bot, roles: ['worker'] },
  { id: 'po', label: '项目负责人', desc: '规划、协调、审核', icon: Crown, roles: ['project_owner'] },
  { id: 'all', label: '全能型', desc: '兼顾管理与执行', icon: Zap, roles: ['project_owner', 'worker'] },
];

const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', ollama: 'Ollama (本地)' };

export function CreateAgentModal({ open, onClose }) {
  const { createAgent, fetchRuntimes, fetchLlmProviders } = useKSwarm();
  const [step, setStep] = useState(1);
  const [agentType, setAgentType] = useState('worker');
  const [name, setName] = useState('');
  const [runtimeType, setRuntimeType] = useState('xiaok');
  const [runtimes, setRuntimes] = useState([]);
  const [llmProviders, setLlmProviders] = useState([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalogModels, setCatalogModels] = useState([]);

  const isXiaok = runtimeType === 'xiaok';

  useEffect(() => {
    if (!open) return;
    fetchRuntimes().then(r => setRuntimes(r));
    fetchLlmProviders().then(p => setLlmProviders(p));
  }, [open, fetchRuntimes, fetchLlmProviders]);

  useEffect(() => {
    if (isXiaok && provider) {
      fetch(`http://127.0.0.1:4400/llm/models?provider=${provider}`)
        .then(r => r.json())
        .then(d => setCatalogModels(d.models ?? []))
        .catch(() => setCatalogModels([]));
    } else {
      setCatalogModels([]);
    }
  }, [isXiaok, provider]);

  if (!open) return null;

  const reset = () => {
    setStep(1); setAgentType('worker'); setName(''); setRuntimeType('xiaok');
    setProvider(''); setModel(''); setBaseUrl(''); setApiKey(''); setInstructions('');
  };
  const handleClose = () => { reset(); onClose(); };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    const roles = AGENT_TYPES.find(t => t.id === agentType)?.roles || [];
    try {
      const result = await createAgent({
        name: name.trim(), roles, runtimeType: runtimeType || undefined,
        provider: provider || undefined, model: model || undefined,
        baseUrl: (!isXiaok && baseUrl) ? baseUrl : undefined,
        apiKey: (!isXiaok && apiKey) ? apiKey : undefined,
        instructions: instructions || undefined,
      });
      if (result) handleClose();
    } catch (err) { console.error('[CreateAgent] failed:', err); }
    finally { setLoading(false); }
  };

  const runtimeOptions = runtimes.length > 0
    ? [{ type: 'xiaok', displayName: 'xiaok', description: 'xiaok 内置智能体', detected: true }, ...runtimes.filter(r => r.type !== 'xiaok')]
    : [{ type: 'xiaok', displayName: 'xiaok', description: 'xiaok 内置智能体', detected: true }];

  const providerOptions = [
    { value: '', label: '跟随平台配置' },
    ...llmProviders.map(p => ({ value: p, label: PROVIDER_LABELS[p] || p })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={handleClose} data-testid="modal-create-agent">
      <div className="relative w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-300 bg-gray-50 shadow-xl p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-gray-900">{step === 1 ? '选择智能体类型' : '配置智能体'}</h2>
          <button type="button" onClick={handleClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"><X size={16} /></button>
        </div>

        {step === 1 ? (
          <div className="flex flex-col gap-3">
            {AGENT_TYPES.map(type => {
              const Icon = type.icon;
              const selected = agentType === type.id;
              return (
                <button key={type.id} type="button" onClick={() => setAgentType(type.id)}
                  className={`flex items-center gap-3 rounded-xl p-4 text-left transition-colors border ${
                    selected ? 'border-indigo-600 bg-indigo-600/10' : 'border-gray-200 hover:bg-gray-100'
                  }`}>
                  <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${selected ? 'bg-indigo-600' : 'bg-gray-100'}`}>
                    <Icon size={18} className={selected ? 'text-white' : 'text-gray-500'} />
                  </div>
                  <div><p className="text-[13px] font-medium text-gray-900">{type.label}</p><p className="text-[11px] text-gray-500">{type.desc}</p></div>
                </button>
              );
            })}
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={() => setStep(2)} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">下一步</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">名称</label>
              <input data-testid="input-agent-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例：研究员、编码专家" autoFocus
                className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">本机智能体平台</label>
              <div className="flex flex-wrap gap-1.5">
                {runtimeOptions.map(rt => (
                  <button key={rt.type} type="button" onClick={() => setRuntimeType(rt.type)}
                    className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                      runtimeType === rt.type ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:text-gray-900'
                    }`}>
                    {rt.displayName}
                    {rt.type === 'xiaok' && <span className="ml-1 text-[10px] opacity-70">推荐</span>}
                    {!rt.detected && rt.type !== 'xiaok' && <span className="ml-1 text-[10px] opacity-50">未安装</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">LLM 提供商</label>
              <select value={provider} onChange={e => { setProvider(e.target.value); setModel(''); if (!e.target.value) { setBaseUrl(''); setApiKey(''); } }}
                className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500">
                {providerOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <p className="text-[10px] text-gray-500">默认跟随平台已配置的 provider</p>
            </div>
            {provider && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-medium text-gray-500">模型</label>
                  {isXiaok && catalogModels.length > 0 ? (
                    <select value={model} onChange={e => setModel(e.target.value)}
                      className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500">
                      <option value="">选择模型</option>
                      {catalogModels.map(m => <option key={m.id} value={m.id}>{m.label}{m.default ? ' (默认)' : ''}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={model} onChange={e => setModel(e.target.value)}
                      placeholder={provider === 'anthropic' ? 'claude-sonnet-4-20250514' : provider === 'openai' ? 'gpt-4o' : 'llama3'}
                      className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
                  )}
                </div>
                {!isXiaok && (provider === 'openai' || provider === 'ollama') && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-medium text-gray-500">Base URL</label>
                    <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                      placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
                      className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
                  </div>
                )}
                {!isXiaok && provider !== 'ollama' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-medium text-gray-500">API Key</label>
                    <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..."
                      className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
                  </div>
                )}
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">指令 <span className="text-gray-400">(可选)</span></label>
              <textarea value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="系统提示词或行为指令..." rows={2}
                className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500 resize-none" />
            </div>
            <div className="mt-2 flex justify-between">
              <button type="button" onClick={() => setStep(1)} className="rounded-lg px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-100">返回</button>
              <button type="button" onClick={handleCreate} disabled={!name.trim() || loading}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                {loading ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
