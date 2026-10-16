import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import ModalPortal from './ModalPortal';
import Icon from './Icon';
import { useModalDialog } from '../useModalDialog';
import { useTheme } from '../theme';

type Guide = {url: string; title: string; origin: string};
const guides: Record<string, string> = {'/studio/model-guide.html': '模型怎么选', '/studio/agent-guide.html': 'Agent 使用指南'};

function Reader({ guide, close }: {guide: Guide; close: () => void}) {
  const panel = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const reduced = useReducedMotion();
  const [ready, setReady] = useState(false);
  const {theme} = useTheme();
  useEffect(() => { if (frame.current?.contentDocument) frame.current.contentDocument.documentElement.dataset.theme = theme; }, [theme, ready]);
  useModalDialog(true, panel, close);
  useEffect(() => () => frameCleanup.current?.(), []);
  const loaded = () => {
    setReady(true);
    // The documents are same-origin; keep Escape available while reading inside the frame.
    frameCleanup.current?.();
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.documentElement.classList.add('embedded-guide');
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') {event.preventDefault(); close();} };
    const link = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest('a');
      if (anchor?.getAttribute('href') === '/studio/') {event.preventDefault(); close();}
      else if (anchor?.href.startsWith('http') && new URL(anchor.href).origin !== location.origin) {anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';}
    };
    doc.addEventListener('keydown', key); doc.addEventListener('click', link);
    frameCleanup.current = () => {doc.removeEventListener('keydown', key); doc.removeEventListener('click', link);};
  };
  return <ModalPortal><motion.div className="modal-backdrop document-backdrop" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} transition={{duration: reduced ? 0 : .3}} onClick={close}>
    <motion.section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={guide.title} className="document-reader modal" style={{transformOrigin: guide.origin}}
      initial={{opacity: 0, transform: reduced ? 'none' : 'translateY(40px) scale(.86)'}} animate={{opacity: 1, transform: 'translateY(0px) scale(1)'}} exit={{opacity: 0, transform: reduced ? 'none' : 'translateY(32px) scale(.9)', transition:{duration: reduced ? 0 : .28}}} transition={{duration: reduced ? 0 : .48, ease: [.22,1,.36,1]}} onClick={e => e.stopPropagation()}>
      <header><div><Icon name="poster" size={18}/><strong>{guide.title}</strong><span>阅读指南 · 创作草稿已保留</span></div><button data-autofocus className="icon-button" onClick={close} aria-label="关闭文档"><Icon name="close" size={20}/></button></header>
      {!ready ? <div className="document-loading" role="status">正在准备阅读内容…</div> : null}
      <iframe ref={frame} src={guide.url} title={guide.title} onLoad={loaded} />
    </motion.section>
  </motion.div></ModalPortal>;
}

export default function DocumentReader({ children }: {children: ReactNode}) {
  const [guide, setGuide] = useState<Guide | null>(null);
  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
      if (!link) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || !guides[url.pathname]) return;
      event.preventDefault();
      const r = link.getBoundingClientRect();
      setGuide({url: `${url.pathname}?v=glass-theme-20261016`, title: guides[url.pathname], origin: `${Math.round((r.left + r.width/2) / innerWidth * 100)}% ${Math.round((r.top+r.height/2) / innerHeight *100)}%`});
    };
    document.addEventListener('click', open);
    return () => document.removeEventListener('click', open);
  }, []);
  return <>{children}<AnimatePresence>{guide ? <Reader key={guide.url} guide={guide} close={() => setGuide(null)}/> : null}</AnimatePresence></>;
}
