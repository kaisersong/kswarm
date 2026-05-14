import { useEffect, useRef } from 'react';
import { useT } from '../i18n';

const LEVEL_STYLES = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

export function LogPanel({ logs, onRefresh }) {
  const { t } = useT();
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold">{t('logs.title')}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{t('logs.subtitle')}</p>
        </div>
        <button
          onClick={() => onRefresh?.(500)}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          {t('logs.refresh')}
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-xs">
        {logs.length === 0 ? (
          <div className="p-6 text-center text-zinc-500">
            <p>{t('logs.empty')}</p>
          </div>
        ) : (
          <div className="p-4 space-y-0.5">
            {logs.map((entry, i) => (
              <LogEntry key={i} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LogEntry({ entry }) {
  const levelStyle = LEVEL_STYLES[entry.level] || 'text-zinc-400';
  const time = entry.ts ? new Date(entry.ts).toLocaleTimeString('en', { hour12: false }) : '';
  const dataStr = entry.data && Object.keys(entry.data).length > 0
    ? JSON.stringify(entry.data)
    : '';

  return (
    <div className="flex items-start gap-2 py-0.5 hover:bg-zinc-900/50 px-2 rounded">
      <span className="text-zinc-600 shrink-0 w-16">{time}</span>
      <span className={`shrink-0 w-12 uppercase font-bold ${levelStyle}`}>{entry.level}</span>
      <span className="text-zinc-300">{entry.msg}</span>
      {dataStr && (
        <span className="text-zinc-600 truncate ml-2">{dataStr}</span>
      )}
    </div>
  );
}
