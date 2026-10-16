import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Icon from './Icon';

type Option = {value: string; label: string};

/** Desktop select: keep focus on the trigger while navigating the list. */
export default function GlassSelect({label, value, options, onChange}: {label: string; value: string; options: Option[]; onChange: (value: string) => void}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const reveal = () => { setActive(selected); setOpen(true); };
  const choose = (index: number) => { if (options[index]) onChange(options[index].value); setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'}); }, [active, id, open]);
  return <div ref={root} className={`glass-select ${open ? 'is-open' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span id={`${id}-label`} className="glass-select-label">{label}</span>
    <button ref={trigger} type="button" className="glass-select-trigger" role="combobox" aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => open ? setOpen(false) : reveal()} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) reveal(); else setActive(index => Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
        else if (open && (event.key === 'Home' || event.key === 'End')) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : options.length - 1); }
        else if (open && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(active); }
        else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) { const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())); if (index >= 0) { event.preventDefault(); setActive(index); setOpen(true); } }
      }}><span>{options[selected]?.label ?? value}</span><Icon name="chevron" size={15}/></button>
    <AnimatePresence>{open ? <motion.div className="glass-select-menu" id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} initial={{opacity:0,y:8,scale:.97}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:5,scale:.98}} transition={{duration:reduced ? 0 : .2}}>
      {options.map((option,index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} className={`glass-select-option ${active === index ? 'is-active' : ''}`} onPointerMove={() => setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value ? <Icon name="check" size={15}/> : null}</div>)}
    </motion.div> : null}</AnimatePresence>
  </div>;
}
