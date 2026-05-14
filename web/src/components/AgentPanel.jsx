import { useState, useEffect } from 'react';
import { useT } from '../i18n';

// ─── Agent type presets ───────────────────────────────────────────
const AGENT_TYPES = [
  {
    key: 'worker',
    label: '执行者',
    desc: '执行具体任务，生成交付物',
    roles: ['worker'],
    capabilities: ['coding', 'testing', 'design', 'planning'],
    instructions: '你是一个专业的执行型 Agent，擅长完成具体的任务并产出高质量的交付物。',
  },
  {
    key: 'po',
    label: '项目负责人',
    desc: '分解目标、分配任务、验收结果',
    roles: ['project_owner'],
    capabilities: ['planning', 'coordination', 'review'],
    instructions: '你是一个项目管理 Agent，负责将项目目标分解为可执行的任务，分配给合适的 worker，并验收最终交付物质量。',
  },
  {
    key: 'all',
    label: '全能型',
    desc: '同时担任 PO 和执行者，适合小项目',
    roles: ['worker', 'project_owner'],
    capabilities: ['coding', 'testing', 'design', 'planning', 'coordination', 'review'],
    instructions: '你是一个全能型 Agent，既能规划和管理项目，也能执行具体任务并产出交付物。',
  },
];

// ─── Model presets per provider ───────────────────────────────────
const PROVIDER_MODELS = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'o3-mini', label: 'o3-mini' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  ollama: [
    { value: 'llama3.1', label: 'Llama 3.1' },
    { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B' },
    { value: 'deepseek-coder-v2', label: 'DeepSeek Coder V2' },
    { value: 'mistral', label: 'Mistral' },
  ],
};

export function AgentPanel({ kswarm }) {
  const { t } = useT();
  const { agents, participants, fetchAgents, fetchParticipants, createAgent, startAgent, stopAgent, archiveAgent, updateAgent, probeAgent } = kswarm;
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [probeResults, setProbeResults] = useState({}); // agentId → probe result

  // Probe all CLI agents on mount and when agents change
  useEffect(() => {
    if (!agents.length) return;
    const cliAgents = agents.filter(a => a.runtimeType && a.runtimeType !== 'builtin');
    if (cliAgents.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = {};
      for (const a of cliAgents) {
        try {
          const r = await probeAgent(a.id);
          if (!cancelled) results[a.id] = r;
        } catch { if (!cancelled) results[a.id] = { healthy: false, message: 'probe failed' }; }
      }
      if (!cancelled) setProbeResults(prev => ({ ...prev, ...results }));
    })();
    return () => { cancelled = true; };
  }, [agents, probeAgent]);

  // Runtime participants from broker
  const brokerAgents = participants.filter(p =>
    p.kind === 'agent' && !p.participantId.startsWith('kswarm-') && !p.participantId.startsWith('e2e-')
  );
  const onlineIds = new Set(brokerAgents.map(p => p.participantId));

  // Unregistered: online in broker but not in agent store
  const registeredIds = new Set(agents.map(a => a.id));
  const unregisteredAgents = brokerAgents.filter(p => !registeredIds.has(p.participantId));

  const handleRename = async (agentId) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    const res = await updateAgent(agentId, { name: renameValue.trim() });
    if (res.ok) fetchAgents();
    setRenamingId(null);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">{t('agents.title')}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">管理你的智能体，启动后可参与项目执行</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { fetchAgents(); fetchParticipants(); }}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            刷新
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors"
          >
            + 新建智能体
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateAgentForm
          agents={agents}
          onClose={() => setShowCreate(false)}
          onCreate={async (data) => {
            const res = await createAgent(data);
            if (res.ok) { setShowCreate(false); fetchAgents(); }
            return res;
          }}
        />
      )}

      {editingAgent && (
        <EditAgentForm
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          onSave={async (patch) => {
            const res = await updateAgent(editingAgent.id, patch);
            if (res.ok) { setEditingAgent(null); fetchAgents(); }
            return res;
          }}
        />
      )}

      {/* ─── My Agents (from store) ─────────────────── */}
      <section className="mb-6">
        <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
          我的智能体 ({agents.length})
        </h2>
        {agents.length === 0 ? (
          <div className="p-8 border border-dashed border-zinc-800 rounded-xl text-center">
            <p className="text-sm text-zinc-500">还没有智能体</p>
            <p className="text-xs text-zinc-600 mt-1">点击「新建智能体」快速创建一个，选择类型、取名、选模型即可</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {agents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isOnline={onlineIds.has(agent.id)}
                probe={probeResults[agent.id]}
                isRenaming={renamingId === agent.id}
                renameValue={renameValue}
                onRenameStart={() => { setRenamingId(agent.id); setRenameValue(agent.name); }}
                onRenameChange={setRenameValue}
                onRenameConfirm={() => handleRename(agent.id)}
                onRenameCancel={() => setRenamingId(null)}
                onStart={() => startAgent(agent.id).then(fetchAgents)}
                onStop={() => stopAgent(agent.id).then(fetchAgents)}
                onEdit={() => setEditingAgent(agent)}
                onArchive={() => { if (confirm(`确定归档 "${agent.name}"？`)) archiveAgent(agent.id).then(fetchAgents); }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ─── Discovered (unregistered broker participants) ─── */}
      {unregisteredAgents.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
            在线发现（未纳入管理） ({unregisteredAgents.length})
          </h2>
          <p className="text-[11px] text-zinc-600 mb-2">这些 agent 通过 Broker 连接，但未在本地注册，不能被选为项目负责人</p>
          <div className="grid gap-2">
            {unregisteredAgents.map(p => (
              <div key={p.participantId} className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-yellow-500/20 text-yellow-400">
                  <span className="text-xs font-bold">{(p.alias || p.participantId).charAt(0).toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{p.alias || p.participantId}</span>
                    <span className="text-[10px] text-zinc-600 font-mono">{p.participantId}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {p.roles?.map(r => (
                      <span key={r} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{r}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[10px] text-zinc-500">在线</span>
                  <button
                    onClick={async () => {
                      const res = await createAgent({
                        id: p.participantId,
                        name: p.alias || p.participantId,
                        roles: p.roles || ['worker'],
                        capabilities: p.capabilities || [],
                      });
                      if (res.ok) fetchAgents();
                    }}
                    className="px-2 py-0.5 text-[10px] rounded border text-indigo-400 hover:bg-indigo-900/30 border-indigo-700/40 transition-colors"
                  >
                    纳入管理
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Create Agent Form (simplified) ───────────────────────────────

function CreateAgentForm({ agents, onClose, onCreate }) {
  const [step, setStep] = useState(1); // 1: type, 2: name+runtime
  const [selectedType, setSelectedType] = useState(null);
  const [name, setName] = useState('');
  const [runtimeBinding, setRuntimeBinding] = useState(''); // '' = API mode, 'claude'/'codex'/etc
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [instructions, setInstructions] = useState('');

  // Fetch available CLI runtimes from server API (includes all known CLIs)
  const [availableRuntimes, setAvailableRuntimes] = useState([]);
  useEffect(() => {
    fetch('/api/runtimes')
      .then(r => r.json())
      .then(data => {
        if (data.runtimes) {
          setAvailableRuntimes(data.runtimes.filter(rt => rt.detected).map(rt => ({ type: rt.type, path: rt.path, displayName: rt.displayName })));
        }
      })
      .catch(() => {
        // Fallback: derive from existing agents
        const rts = [];
        const seen = new Set();
        for (const a of agents) {
          if (a.runtimeType && a.runtimeType !== 'builtin' && a.runtimePath && !seen.has(a.runtimeType)) {
            seen.add(a.runtimeType);
            rts.push({ type: a.runtimeType, path: a.runtimePath });
          }
        }
        setAvailableRuntimes(rts);
      });
  }, []);

  const handleSelectType = (type) => {
    setSelectedType(type);
    setInstructions(type.instructions);
    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setCreating(true);

    const data = {
      name: name.trim(),
      roles: selectedType.roles,
      capabilities: selectedType.capabilities,
      instructions: instructions.trim(),
    };

    // Bind to CLI runtime
    if (runtimeBinding) {
      const rt = availableRuntimes.find(r => r.type === runtimeBinding);
      if (rt) {
        data.runtimeType = rt.type;
        data.runtimePath = rt.path;
      }
    }

    // LLM API config (fallback or primary if no CLI)
    if (provider) {
      data.provider = provider;
      if (model) data.model = model;
      if (baseUrl) data.baseUrl = baseUrl;
      if (apiKey) data.apiKey = apiKey;
    }

    const res = await onCreate(data);
    if (res?.error) setError(res.error);
    setCreating(false);
  };

  return (
    <div className="mb-6 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">
          {step === 1 ? '选择智能体类型' : '配置智能体'}
        </h3>
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">关闭</button>
      </div>

      {/* Step 1: Choose type */}
      {step === 1 && (
        <div className="grid grid-cols-3 gap-3">
          {AGENT_TYPES.map(type => (
            <button key={type.key} type="button" onClick={() => handleSelectType(type)}
              className="p-4 rounded-lg border border-zinc-700 bg-zinc-900/50 text-left hover:border-indigo-500/50 hover:bg-indigo-900/10 transition-colors group">
              <div className="text-sm font-medium text-zinc-200 group-hover:text-indigo-300">{type.label}</div>
              <p className="text-[11px] text-zinc-500 mt-1">{type.desc}</p>
              <div className="flex gap-1 mt-2 flex-wrap">
                {type.roles.map(r => (
                  <span key={r} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{r}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Step 2: Name + Model */}
      {step === 2 && (
        <form onSubmit={handleSubmit}>
          <div className="flex items-center gap-2 mb-4">
            <button type="button" onClick={() => setStep(1)}
              className="text-xs text-zinc-500 hover:text-zinc-300">
              &larr; 返回
            </button>
            <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-900/30 text-indigo-300 border border-indigo-700/40">
              {selectedType.label}
            </span>
          </div>

          {/* Runtime binding selector - only show when CLI runtimes are available */}
          {availableRuntimes.length > 0 && (
            <div className="mb-3">
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">运行时绑定</label>
              <div className="flex flex-wrap gap-2">
                {/* xiaok native agent first (if detected) */}
                {availableRuntimes.filter(rt => rt.type === 'xiaok').map(rt => (
                  <button key={rt.type} type="button"
                    onClick={() => setRuntimeBinding(rt.type)}
                    className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                      runtimeBinding === rt.type
                        ? 'border-indigo-500 bg-indigo-900/20 text-indigo-300'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                    }`}>
                    xiaok（推荐）
                  </button>
                ))}
                {/* Third-party CLIs */}
                {availableRuntimes.filter(rt => rt.type !== 'xiaok').map(rt => (
                  <button key={rt.type} type="button"
                    onClick={() => setRuntimeBinding(rt.type)}
                    className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                      runtimeBinding === rt.type
                        ? 'border-indigo-500 bg-indigo-900/20 text-indigo-300'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                    }`}>
                    {rt.displayName || rt.type}（第三方）
                  </button>
                ))}
                <button type="button"
                  onClick={() => setRuntimeBinding('')}
                  className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                    runtimeBinding === ''
                      ? 'border-indigo-500 bg-indigo-900/20 text-indigo-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                  }`}>
                  API 模式（无 CLI）
                </button>
              </div>
              {runtimeBinding === 'xiaok' && (
                <p className="text-[10px] text-zinc-600 mt-1">
                  使用 xiaok 已配置的模型执行任务
                </p>
              )}
              {runtimeBinding && runtimeBinding !== 'xiaok' && (
                <p className="text-[10px] text-zinc-600 mt-1">
                  使用第三方 {runtimeBinding} CLI 执行任务，下方 LLM 配置作为回退
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">名称 *</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)}
                placeholder="如: Alpha、小明、Code-Worker-1"
                required
                className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                {runtimeBinding ? 'LLM 回退提供商（可选）' : 'LLM 提供商'}
              </label>
              <select value={provider} onChange={e => { setProvider(e.target.value); setModel(''); }}
                className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500">
                <option value="">暂不配置（使用环境变量）</option>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama（本地）</option>
              </select>
            </div>
          </div>

          {provider && (
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">模型</label>
                <div className="flex gap-1">
                  <select value={model} onChange={e => setModel(e.target.value)}
                    className="flex-1 px-2 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500">
                    <option value="">选择模型...</option>
                    {(PROVIDER_MODELS[provider] || []).map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <input value={model} onChange={e => setModel(e.target.value)}
                    placeholder="或输入自定义"
                    className="w-28 px-2 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
              {provider !== 'anthropic' && (
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Base URL</label>
                  <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                    placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
                </div>
              )}
              {provider !== 'ollama' && (
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">API Key</label>
                  <input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password"
                    placeholder="sk-..."
                    className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
                </div>
              )}
            </div>
          )}

          {/* Advanced toggle */}
          <div className="mb-3">
            <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">
              {showAdvanced ? '▾ 收起高级设置' : '▸ 高级设置（Instructions）'}
            </button>
            {showAdvanced && (
              <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
                rows={3}
                placeholder="System prompt..."
                className="w-full mt-2 px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 resize-y" />
            )}
          </div>

          {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

          <button type="submit" disabled={creating || !name.trim()}
            className="px-4 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-colors">
            {creating ? '创建中...' : '创建'}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Edit Agent Form (LLM config + instructions) ──────────────────

function EditAgentForm({ agent, onClose, onSave }) {
  const [name, setName] = useState(agent.name || '');
  const [instructions, setInstructions] = useState(agent.instructions || '');
  const [provider, setProvider] = useState(agent.provider || '');
  const [model, setModel] = useState(agent.model || '');
  const [baseUrl, setBaseUrl] = useState(agent.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    const patch = { name: name.trim(), instructions };
    if (provider) {
      patch.provider = provider;
      patch.model = model || null;
      patch.baseUrl = baseUrl || null;
      if (apiKey) patch.apiKey = apiKey;
    } else {
      patch.provider = null;
      patch.model = null;
      patch.baseUrl = null;
      patch.apiKey = null;
    }

    const res = await onSave(patch);
    if (res?.error) setError(res.error);
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="mb-6 p-4 rounded-xl border border-indigo-500/30 bg-zinc-900/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">编辑智能体</h3>
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">关闭</button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">名称</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">ID（不可修改）</label>
          <input value={agent.id} disabled
            className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-500 font-mono" />
        </div>
      </div>

      <div className="mb-3">
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Instructions</label>
        <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500 resize-y" />
      </div>

      <div className="mb-3">
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 block">LLM 配置</label>
        <div className="grid grid-cols-4 gap-2">
          <select value={provider} onChange={e => { setProvider(e.target.value); setModel(''); }}
            className="px-2 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500">
            <option value="">无 LLM</option>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
          </select>
          <div className="flex gap-1">
            <select value={model} onChange={e => setModel(e.target.value)}
              className="flex-1 px-2 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500">
              <option value="">模型...</option>
              {(PROVIDER_MODELS[provider] || []).map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <input value={model} onChange={e => setModel(e.target.value)} placeholder="自定义"
              className="w-20 px-2 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
          </div>
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="base URL"
            className="px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
          <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="新 API Key（留空不改）" type="password"
            className="px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
        </div>
        {agent.apiKey && !apiKey && <p className="text-[10px] text-zinc-600 mt-1">当前已配置 API Key (****)</p>}
      </div>

      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <button type="submit" disabled={saving || !name.trim()}
        className="px-4 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-colors">
        {saving ? '保存中...' : '保存'}
      </button>
    </form>
  );
}

// ─── Agent Card (with inline rename) ──────────────────────────────

const STATUS_STYLES = {
  idle: { dot: 'bg-green-500', text: '空闲' },
  working: { dot: 'bg-blue-500 animate-pulse', text: '工作中' },
  blocked: { dot: 'bg-yellow-500', text: '阻塞' },
  error: { dot: 'bg-red-500', text: '错误' },
  offline: { dot: 'bg-zinc-600', text: '离线' },
};

function AgentCard({ agent, isOnline, probe, isRenaming, renameValue, onRenameStart, onRenameChange, onRenameConfirm, onRenameCancel, onStart, onStop, onEdit, onArchive }) {
  const status = isOnline ? (agent.status === 'offline' ? 'idle' : agent.status) : 'offline';
  const { dot, text } = STATUS_STYLES[status] || STATUS_STYLES.offline;

  const typeLabel = agent.roles?.includes('project_owner') && agent.roles?.includes('worker')
    ? '全能型'
    : agent.roles?.includes('project_owner')
    ? '项目负责人'
    : '执行者';

  // CLI health indicator
  const hasCLI = agent.runtimeType && agent.runtimeType !== 'builtin';
  const cliHealthy = probe?.healthy;
  const cliLabel = hasCLI
    ? (agent.runtimeType === 'xiaok' ? 'xiaok' : `${agent.runtimeType}（第三方）`)
    : null;

  return (
    <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/30 hover:border-zinc-700 transition-colors">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-indigo-500/20 text-indigo-400">
          <span className="text-sm font-bold">{agent.name.charAt(0).toUpperCase()}</span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isRenaming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => onRenameChange(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onRenameConfirm(); if (e.key === 'Escape') onRenameCancel(); }}
                  onBlur={onRenameConfirm}
                  className="px-2 py-0.5 text-sm rounded border border-indigo-500 bg-zinc-900 text-zinc-200 focus:outline-none w-32"
                />
              </div>
            ) : (
              <>
                <span className="text-sm font-medium text-zinc-200 cursor-pointer hover:text-indigo-300 transition-colors"
                  onDoubleClick={onRenameStart} title="双击改名">
                  {agent.name}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
                  {typeLabel}
                </span>
              </>
            )}
          </div>
          {agent.description && (
            <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{agent.description}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* CLI runtime badge */}
            {hasCLI && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                cliHealthy === true
                  ? 'bg-green-900/30 text-green-400 border-green-700/40'
                  : cliHealthy === false
                  ? 'bg-red-900/30 text-red-400 border-red-700/40'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700'
              }`} title={probe?.version || probe?.message || '探测中...'}>
                {cliLabel} CLI {cliHealthy === true ? '✓' : cliHealthy === false ? '✗' : '…'}
              </span>
            )}
            {!hasCLI && agent.provider && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-700/40">
                {agent.provider}{agent.model ? ` : ${agent.model}` : ''}
              </span>
            )}
            {!hasCLI && !agent.provider && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
                未配 LLM
              </span>
            )}
            {/* Show version on hover via title, or error message */}
            {probe?.version && (
              <span className="text-[9px] text-zinc-600">{probe.version}</span>
            )}
            {probe?.healthy === false && probe?.message && (
              <span className="text-[9px] text-red-500 truncate max-w-[200px]" title={probe.message}>
                {probe.message.slice(0, 60)}
              </span>
            )}
          </div>
        </div>

        {/* Status + Actions */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            <span className="text-[10px] text-zinc-500">{text}</span>
          </div>
          <div className="flex gap-1">
            {status === 'offline' ? (
              <ActionBtn onClick={onStart} color="green">启动</ActionBtn>
            ) : (
              <ActionBtn onClick={onStop} color="red">停止</ActionBtn>
            )}
            <ActionBtn onClick={onRenameStart} color="zinc">改名</ActionBtn>
            <ActionBtn onClick={onEdit} color="zinc">配置</ActionBtn>
            <ActionBtn onClick={onArchive} color="zinc">归档</ActionBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────

function ActionBtn({ children, onClick, color = 'zinc' }) {
  const colors = {
    green: 'text-green-400 hover:bg-green-900/30 border-green-700/40',
    red: 'text-red-400 hover:bg-red-900/30 border-red-700/40',
    zinc: 'text-zinc-400 hover:bg-zinc-800 border-zinc-700',
  };
  return (
    <button onClick={onClick}
      className={`px-2 py-0.5 text-[10px] rounded border ${colors[color]} transition-colors`}>
      {children}
    </button>
  );
}
