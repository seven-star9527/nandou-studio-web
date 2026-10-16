import { Children, cloneElement, isValidElement, useId, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';

/** One moving lens per choice group; preserves the buttons' native semantics. */
export default function GlassTabs({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  const id = useId();
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const choices = Children.toArray(children);
  const selectedIndex = choices.findIndex(child => isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child) && (/(?:^|\s)(selected|active)(?:\s|$)/.test(child.props.className ?? '') || child.props['aria-selected'] === true || child.props['aria-checked'] === true));
  const lensIndex = hover ?? selectedIndex;
  return <LayoutGroup id={id}><div {...props} className={`glass-tabs ${className}`} onPointerLeave={() => setHover(null)} onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)}>
    {choices.map((child, index) => {
      if (!isValidElement<ButtonHTMLAttributes<HTMLButtonElement> & {children?: ReactNode}>(child) || child.type !== 'button') return child;
      const p = child.props;
      const active = /(?:^|\s)(selected|active)(?:\s|$)/.test(p.className ?? '') || p['aria-selected'] === true || p['aria-checked'] === true;
      const transition = reduced || keyboard ? {duration: 0} : {type: 'spring' as const, duration: .5, bounce: .2};
      return cloneElement(child, {
        onPointerEnter: event => { if (event.pointerType === 'mouse' && !p.disabled) { setKeyboard(false); setHover(index); } p.onPointerEnter?.(event); },
        children: <>{lensIndex === index ? <motion.span aria-hidden className={`glass-tab-lens ${active ? '' : 'is-hovering'}`} layoutId="selected" transition={transition} /> : null}{p.children}</>,
      });
    })}
  </div></LayoutGroup>;
}
