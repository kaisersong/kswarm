export function Header({ connected, participants }) {
  const onlineCount = participants.filter(p => p.kind === 'agent').length;

  return (
    <header className="h-14 border-b border-zinc-800 flex items-center px-5 gap-4 shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-xs font-bold">
          K
        </div>
        <span className="text-sm font-semibold tracking-tight">KSwarm</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          {connected ? 'Broker Connected' : 'Disconnected'}
        </span>

        {onlineCount > 0 && (
          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
            {onlineCount} agents
          </span>
        )}
      </div>
    </header>
  );
}
