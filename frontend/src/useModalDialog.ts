import { useLayoutEffect, useRef, type RefObject } from 'react';

const dialogs: HTMLElement[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let originalBodyStyle: { overflow: string; paddingRight: string } | undefined;
let observer: MutationObserver | undefined;
const focusSelector = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),iframe,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
const focusable = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector))
  .filter(item => item.getClientRects().length > 0 && !item.closest('[inert]'));

function isolateTopDialog() {
  const overlay = dialogs.at(-1)?.closest('.modal-backdrop');
  if (!overlay) return;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!originalInert.has(child)) originalInert.set(child, child.inert);
    child.inert = child === overlay ? originalInert.get(child)! : true;
  }
}

export function useModalDialog(open: boolean, container: RefObject<HTMLElement | null>, onClose?: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const dialog = container.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialogs.length) {
      originalBodyStyle = { overflow: document.body.style.overflow, paddingRight: document.body.style.paddingRight };
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${parseFloat(getComputedStyle(document.body).paddingRight) + scrollbarWidth}px`;
      observer = new MutationObserver(isolateTopDialog);
      observer.observe(document.body, { childList: true });
    }
    dialogs.push(dialog);
    isolateTopDialog();
    const focusFirst = () => (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable(dialog)[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focusFirst();
    const key = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape' && close.current) { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(dialog);
      const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (!dialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const containFocus = () => { if (dialogs.at(-1) === dialog && !dialog.contains(document.activeElement)) focusFirst(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', containFocus);
      const index = dialogs.indexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      if (dialogs.length) isolateTopDialog();
      else {
        observer?.disconnect(); observer = undefined;
        for (const [element, inert] of originalInert) element.inert = inert;
        originalInert.clear();
        if (originalBodyStyle) { document.body.style.overflow = originalBodyStyle.overflow; document.body.style.paddingRight = originalBodyStyle.paddingRight; originalBodyStyle = undefined; }
      }
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
      else { const top = dialogs.at(-1); if (top) (focusable(top)[0] ?? top).focus({ preventScroll: true }); }
    };
  }, [open, container]);
}
