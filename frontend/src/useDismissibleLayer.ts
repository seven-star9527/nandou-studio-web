import { useEffect, useRef, type RefObject } from 'react';

/** A popover closes outside its panel/trigger, including empty composer space. */
export function useDismissibleLayer(open: boolean, boundary: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (boundary.current?.contains(target) && target.closest('[role="dialog"], [data-layer-trigger]')) return;
      latest.current();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') latest.current(); };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key); };
  }, [open, boundary]);
}
