import { useT } from '../i18n';

export function StatusBar({ connected, brokerConnected }) {
  const { t } = useT();

  return (
    <div className="flex items-center gap-3 text-xs text-zinc-400">
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        {connected ? t('status.connected') : t('status.disconnected')}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${brokerConnected ? 'bg-green-500' : 'bg-yellow-500'}`} />
        {brokerConnected ? t('status.brokerConnected') : t('status.brokerDisconnected')}
      </span>
    </div>
  );
}
