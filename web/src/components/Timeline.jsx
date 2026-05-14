const KIND_STYLES = {
  request_task: { icon: '>', color: 'text-blue-400' },
  accept_task: { icon: '+', color: 'text-cyan-400' },
  report_progress: { icon: '*', color: 'text-yellow-400' },
  submit_result: { icon: '!', color: 'text-green-400' },
  respond_approval: { icon: 'A', color: 'text-purple-400' },
  request_approval: { icon: '?', color: 'text-orange-400' },
  participant_presence_updated: { icon: 'P', color: 'text-zinc-500' },
  participant_alias_updated: { icon: 'P', color: 'text-zinc-600' },
};

export function Timeline({ events }) {
  if (events.length === 0) {
    return (
      <div className="p-4 text-center text-zinc-500 text-sm">
        <p className="text-zinc-600">Waiting for events...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-4 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-950/90 backdrop-blur-sm">
        <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Event Stream
        </h2>
        <span className="text-[10px] text-zinc-600">{events.length} events</span>
      </div>
      <div className="flex flex-col">
        {events.map((event, i) => (
          <EventRow key={event.eventId || i} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventRow({ event }) {
  const { kind, fromAlias, fromParticipantId, payload, timestamp, taskId } = event;
  const style = KIND_STYLES[kind] || { icon: '.', color: 'text-zinc-500' };

  // Skip noisy presence events in display
  if (kind === 'participant_presence_updated' || kind === 'participant_alias_updated') {
    return null;
  }

  const time = timestamp ? new Date(timestamp).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const sender = fromAlias || fromParticipantId?.split('-')[0] || '?';
  const summary = deriveSummary(kind, payload);

  return (
    <div className="px-4 py-2 border-b border-zinc-800/50 hover:bg-zinc-900/50 flex items-start gap-2 group">
      {/* Icon */}
      <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono font-bold bg-zinc-800/50 shrink-0 mt-0.5 ${style.color}`}>
        {style.icon}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">{sender}</span>
          <span className="text-[10px] text-zinc-600 font-mono">{kind.replace(/_/g, ' ')}</span>
        </div>
        {summary && (
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{summary}</p>
        )}
      </div>

      {/* Time */}
      <span className="text-[10px] text-zinc-600 font-mono shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {time}
      </span>
    </div>
  );
}

function deriveSummary(kind, payload) {
  if (!payload) return null;

  switch (kind) {
    case 'request_task':
      return payload.title || payload.body?.summary || null;
    case 'submit_result':
      return payload.summary || null;
    case 'report_progress':
      return payload.stage || null;
    case 'respond_approval':
      return payload.decision || null;
    default:
      return payload.body?.summary || null;
  }
}
