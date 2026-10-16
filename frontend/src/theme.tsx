import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'dark' | 'light';
const ThemeContext = createContext<{theme: Theme; toggle: (button: HTMLElement) => void}>({theme: 'dark', toggle: () => {}});
export const useTheme = () => useContext(ThemeContext);

export function ThemeProvider({children}: {children: ReactNode}) {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const switching = useRef(false);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'nandou-theme') setTheme(event.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggle = async (button: HTMLElement) => {
    if (switching.current) return;
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      document.documentElement.dataset.theme = next;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'light' ? '#f5f6f7' : '#101415');
      try { localStorage.setItem('nandou-theme', next); } catch { /* Theme still works without storage. */ }
      flushSync(() => setTheme(next));
    };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
    switching.current = true;
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth-x), Math.max(y, innerHeight-y));
    const transition = document.startViewTransition(apply);
    try {
      await transition.ready;
      await document.documentElement.animate({clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]}, {duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)'}).finished;
    } catch { /* An interrupted transition must never prevent a theme change. */ }
    finally { switching.current = false; }
  };
  return <ThemeContext value={{theme, toggle: button => void toggle(button)}}>{children}</ThemeContext>;
}

export function ThemeToggle() {
  const {theme, toggle} = useTheme();
  return <button className="theme-toggle icon-button" aria-label={theme === 'dark' ? '切换到明亮模式' : '切换到黑暗模式'} title={theme === 'dark' ? '明亮模式' : '黑暗模式'} onClick={e => toggle(e.currentTarget)}>
    <svg className={`theme-symbol ${theme}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><g className="theme-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></g><path className="theme-moon" d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z"/></svg>
  </button>;
}
