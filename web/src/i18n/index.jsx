import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import en from './locales/en.json'
import zh from './locales/zh.json'

const locales = { en, zh }
const STORAGE_KEY = 'kswarm-lang'

function detectLocale() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && locales[saved]) return saved
  const nav = navigator.language || ''
  return nav.startsWith('zh') ? 'zh' : 'en'
}

function get(obj, path) {
  return path.split('.').reduce((acc, key) => acc && acc[key], obj)
}

const I18nContext = createContext(null)

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(detectLocale)

  const setLocale = useCallback((lang) => {
    if (locales[lang]) {
      setLocaleState(lang)
      localStorage.setItem(STORAGE_KEY, lang)
    }
  }, [])

  const t = useCallback((key) => {
    return get(locales[locale], key) ?? key
  }, [locale])

  const value = useMemo(() => ({ t, locale, setLocale }), [t, locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT must be used within I18nProvider')
  return ctx
}
