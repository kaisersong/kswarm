import { useT } from '../i18n';

export function SettingsPanel() {
  const { t, locale, setLocale } = useT();

  const handleFollowSystem = () => {
    localStorage.removeItem('kswarm-lang');
    const nav = navigator.language || '';
    setLocale(nav.startsWith('zh') ? 'zh' : 'en');
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-1">{t('settings.title')}</h1>
      <p className="text-xs text-zinc-500 mb-8">{t('settings.languageDesc')}</p>

      {/* Language */}
      <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/30">
        <h3 className="text-sm font-medium mb-3">{t('settings.language')}</h3>
        <div className="flex gap-2">
          <button
            onClick={() => setLocale('en')}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
              locale === 'en'
                ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
            }`}
          >
            {t('settings.langEn')}
          </button>
          <button
            onClick={() => setLocale('zh')}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
              locale === 'zh'
                ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
            }`}
          >
            {t('settings.langZh')}
          </button>
          <button
            onClick={handleFollowSystem}
            className="px-4 py-2 text-sm rounded-lg border bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600 transition-colors"
          >
            {t('settings.followSystem')}
          </button>
        </div>
      </div>
    </div>
  );
}
