import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/** Dialogs live outside page stacking contexts and scroll/containment boundaries. */
export default function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
