import { useEffect, useRef, useState } from 'react'

type Theme = 'light' | 'warm' | 'dark'
type Accent = 'indigo' | 'sky' | 'teal' | 'forest' | 'gold' | 'coral' | 'rose' | 'violet'

const themes: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Claro' },
  { id: 'warm', label: 'Cálido' },
  { id: 'dark', label: 'Oscuro' },
]
const accents: { id: Accent; label: string }[] = [
  { id: 'indigo', label: 'Índigo' },
  { id: 'sky', label: 'Cielo' },
  { id: 'teal', label: 'Océano' },
  { id: 'forest', label: 'Bosque' },
  { id: 'gold', label: 'Dorado' },
  { id: 'coral', label: 'Coral' },
  { id: 'rose', label: 'Rosa' },
  { id: 'violet', label: 'Violeta' },
]

function saved<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T
    return allowed.includes(value) ? value : fallback
  } catch { return fallback }
}

const initialTheme = saved('samantha.theme', themes.map((t) => t.id), 'light')
const initialAccent = saved('samantha.accent', accents.map((a) => a.id), 'indigo')
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = initialTheme
  document.documentElement.dataset.accent = initialAccent
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', initialTheme === 'dark' ? '#121b31' : initialTheme === 'warm' ? '#f6f0e5' : '#f5f7fb')
}

export default function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [accent, setAccent] = useState<Accent>(initialAccent)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.accent = accent
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121b31' : theme === 'warm' ? '#f6f0e5' : '#f5f7fb')
    try { localStorage.setItem('samantha.theme', theme); localStorage.setItem('samantha.accent', accent) } catch { /* almacenamiento opcional */ }
  }, [theme, accent])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  return <div className="theme-picker" ref={ref}>
    <button className="theme-trigger" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Cambiar apariencia" title="Cambiar apariencia">
      <span className="theme-trigger-icon" aria-hidden="true">◐</span><span className="theme-trigger-text">Apariencia</span>
    </button>
    {open && <div className="theme-panel" role="dialog" aria-label="Personalizar apariencia">
      <div className="theme-panel-head"><strong>Tu estilo</strong><span>Elegí cómo se ve Samantha</span></div>
      <div className="theme-panel-label">Apariencia</div>
      <div className="theme-options">{themes.map((t) => <button key={t.id} type="button" className={'theme-option ' + t.id + (theme === t.id ? ' selected' : '')} onClick={() => setTheme(t.id)} aria-pressed={theme === t.id}><span className="theme-preview"><i /><i /></span>{t.label}</button>)}</div>
      <div className="theme-panel-label">Estilo de color</div>
      <div className="accent-options">{accents.map((a) => <button key={a.id} type="button" className={'accent-option ' + a.id + (accent === a.id ? ' selected' : '')} onClick={() => setAccent(a.id)} aria-pressed={accent === a.id} aria-label={a.label} title={a.label}><span /><small>{a.label}</small></button>)}</div>
    </div>}
  </div>
}
