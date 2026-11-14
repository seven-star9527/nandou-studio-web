import { useImperativeHandle, useLayoutEffect, useRef, useId, useState, type Ref } from 'react';
import { DOMSerializer, Schema, type Node as DocNode } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { ReferenceImage } from '../types';
import { mentionParts, referenceDragType, referenceToken, resolveMentions } from '../reference-mentions';
import ModalPortal from './ModalPortal';
import './prompt-editor.css';

const schema = new Schema({nodes: {
  doc: {content: 'paragraph'},
  paragraph: {content: 'inline*', whitespace:'pre', toDOM: () => ['p', 0], parseDOM: [{tag:'p', preserveWhitespace:'full'}]},
  text: {group: 'inline'},
  reference: {
    group: 'inline', inline: true, atom: true, draggable: true, attrs: {id: {}},
    toDOM: node => ['span', {'data-reference': node.attrs.id, class: 'prompt-reference', contenteditable: 'false'}, ['img', {alt: '', draggable: 'false'}], ['span']],
  },
}});
function fromText(text: string, references: ReferenceImage[]) {
  const inline = mentionParts(text).map(part => {
    const id = part.slice(5, -1);
    return part === referenceToken(id) && references.some(r => r.id === id)
      ? schema.node('reference', {id}) : schema.text(part);
  });
  return schema.node('doc',null,schema.node('paragraph',null,inline));
}
function toText(doc: DocNode) {
  return doc.textBetween(0, doc.content.size, '', node => referenceToken(node.attrs.id));
}
type MentionQuery = {from: number; to: number; filter: string};
function mentionQuery(view: EditorView): MentionQuery | null {
  const {empty, $from} = view.state.selection;
  if (!empty || !view.editable) return null;
  const prefix = $from.parent.textBetween(0, $from.parentOffset, '', ' ');
  // An address such as name@example.com is ordinary prompt text.
  const match = /(?<![A-Za-z0-9._%+-])[@＠]([^@＠\s]{0,100})$/.exec(prefix);
  return match ? {from:$from.pos - match[0].length, to:$from.pos, filter:match[1]} : null;
}
export interface PromptEditorHandle { focus(): void; selectText(text: string): void }
interface Props {
  editorRef?: Ref<PromptEditorHandle>; label: string; value: string; references: ReferenceImage[];
  placeholder: string; disabled?: boolean; change(value: string): void; submit(text: string): void; enterToSend?: boolean;
}
export default function PromptEditor(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const menuId = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const menu = useRef<HTMLDivElement>(null);
  const matches = query ? props.references.filter((ref, i) =>
    ref.name.toLowerCase().includes(query.filter.toLowerCase()) || String(i + 1) === query.filter) : [];
  const selectedIndex = Math.min(activeIndex, matches.length - 1);
  const picker = useRef({query, matches, selectedIndex});
  picker.current = {query, matches, selectedIndex};
  function chooseReference(view: EditorView, id: string) {
    const at = mentionQuery(view);
    if (!at || !latest.current.references.some(ref => ref.id === id)) return;
    const tr = view.state.tr.replaceWith(at.from, at.to, schema.node('reference', {id}));
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at.from + 1)).scrollIntoView());
    setQuery(null);
    view.focus();
  }
  useLayoutEffect(() => {
    const view = editor.current;
    if (!query || !view || !props.references.length || props.disabled) return;
    const layout = () => {
      const anchor = view.coordsAtPos(query.to);
      const width = Math.min(292, innerWidth - 24);
      const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12;
      const upward = below < Math.min(232, Math.max(matches.length,1) * 40 + 12) && above > below;
      setMenuStyle({width, left:Math.max(12, Math.min(anchor.left, innerWidth - width - 12)),
        ...(upward ? {bottom:innerHeight - anchor.top + 4} : {top:anchor.bottom + 4}), maxHeight:Math.min(232, Math.max(40, (upward ? above : below) - 4))});
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) layout(); };
    layout();
    window.addEventListener('resize',layout);
    document.addEventListener('scroll',scroll,true);
    return () => {window.removeEventListener('resize',layout);document.removeEventListener('scroll',scroll,true);};
  }, [query, matches.length, props.disabled, props.references.length]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const option = menu.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (menu.current) {
      view.dom.setAttribute('aria-controls',menuId);
      option?.scrollIntoView({block:'nearest'});
    } else view.dom.removeAttribute('aria-controls');
    if (option) view.dom.setAttribute('aria-activedescendant',option.id);
    else view.dom.removeAttribute('aria-activedescendant');
  }, [query, selectedIndex, menuId, matches.length, props.disabled]);
  function decorate(view: EditorView) {
    for (const chip of view.dom.querySelectorAll<HTMLElement>('.prompt-reference')) {
      const index = latest.current.references.findIndex(ref => ref.id === chip.dataset.reference);
      const image = latest.current.references[index];
      if (!image) continue;
      const thumb = chip.querySelector('img')!;
      if (thumb.getAttribute('src') !== image.dataUrl) thumb.src = image.dataUrl;
      const name = chip.lastElementChild!;
      if (name.textContent !== image.name) name.textContent = image.name;
      chip.title = `参考图 ${index + 1} · ${image.name}`;
      chip.setAttribute('aria-label', chip.title);
    }
  }
  useImperativeHandle(props.editorRef, () => ({
    focus: () => editor.current?.focus(),
    selectText: text => {
      const view = editor.current;
      if (!view) return;
      view.focus();
      let found = false;
      view.state.doc.descendants((node, pos) => {
        const i = node.text?.indexOf(text) ?? -1;
        if (!found && i >= 0) {
          found = true;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + i, pos + i + text.length)));
        }
      });
    },
  }), []);
  useLayoutEffect(() => {
    const cursor = caret.current!;
    const hideCursor = () => { cursor.hidden = true; };
    function targetAt(view: EditorView, event: DragEvent) {
      const hit = view.posAtCoords({left:event.clientX, top:event.clientY});
      return hit && Math.max(1, Math.min(hit.pos, view.state.doc.content.size - 1));
    }
    function showCursor(view: EditorView, event: DragEvent, pos: number) {
      // At a wrapped line boundary, both visual carets represent the same document position.
      const before = view.coordsAtPos(pos, -1), after = view.coordsAtPos(pos, 1);
      const distance = (rect: typeof before) => Math.abs(event.clientY - (rect.top + rect.bottom) / 2);
      const point = distance(before) < distance(after) ? before : after;
      const bounds = view.dom.getBoundingClientRect();
      const parent = cursor.parentElement!.getBoundingClientRect();
      const top = Math.max(bounds.top, point.top), bottom = Math.min(bounds.bottom, point.bottom);
      if (bottom <= top) { hideCursor(); return; }
      cursor.style.left = Math.max(bounds.left, Math.min(point.left, bounds.right - 2)) - parent.left + 'px';
      cursor.style.top = top - parent.top + 'px';
      cursor.style.height = bottom - top + 'px';
      cursor.hidden = false;
    }
    const view = new EditorView(mount.current!, {
      state: EditorState.create({doc: fromText(latest.current.value, latest.current.references),
        plugins: [history(), keymap({'Mod-z':undo, 'Mod-y':redo, 'Shift-Mod-z':redo}), keymap(baseKeymap),
          new Plugin({filterTransaction(tr) {
            if (!tr.docChanged) return true;
            let valid = true;
            tr.doc.descendants(node => {
              if (node.type === schema.nodes.reference && !latest.current.references.some(ref => ref.id === node.attrs.id)) valid = false;
            });
            return valid;
          }})]}),
      editable: () => !latest.current.disabled,
      nodeViews: {
        reference(node) {
          const dom = DOMSerializer.fromSchema(schema).serializeNode(node) as HTMLElement;
          return {dom, ignoreMutation: mutation => mutation.type !== 'selection'};
        },
      },
      attributes: {role: 'textbox', 'aria-multiline':'true', 'aria-label': latest.current.label, class:'reference-prompt'},
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.docChanged) { decorate(view); latest.current.change(toText(next.doc)); }
        if (tr.docChanged || tr.selectionSet) {
          const at = latest.current.references.length && !view.composing ? mentionQuery(view) : null;
          setQuery(at && (tr.docChanged || picker.current.query) ? at : null);
          setActiveIndex(0);
        }
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing || view.composing || event.keyCode === 229) return false;
        const list = picker.current;
        if (list.query && latest.current.references.length) {
          if (event.key === 'Escape') { setQuery(null); return true; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (list.matches.length) setActiveIndex((list.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + list.matches.length) % list.matches.length);
            return true;
          }
          if (event.key === 'Enter') {
            const item = list.matches[list.selectedIndex];
            if (item) chooseReference(view,item.id);
            return true;
          }
        }
        if (event.key !== 'Enter') return false;
        // selectionchange may still be queued after a fast click or Ctrl+End.
        const selection = view.dom.ownerDocument.getSelection();
        if (selection?.anchorNode && selection.focusNode && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
          const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
          const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
          if (anchor !== view.state.selection.anchor || head !== view.state.selection.head)
            view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))));
        }
        if (latest.current.enterToSend ? !event.shiftKey : event.ctrlKey || event.metaKey) latest.current.submit(toText(view.state.doc));
        else view.dispatch(view.state.tr.insertText('\n').scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        blur: () => { setQuery(null); return false; },
        compositionend: (view) => {
          requestAnimationFrame(() => {
            if (editor.current === view && view.hasFocus() && latest.current.references.length) setQuery(mentionQuery(view));
          });
          return false;
        },
        paste: (view, event) => {
          if (Array.from(event.clipboardData?.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) return true; // Dock handles the image at document level.
          const text = event.clipboardData?.getData('text/plain');
          event.preventDefault();
          if (text) view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g,'\n')).scrollIntoView());
          return true;
        },
        dragover: (view, event) => {
          const fromDock = event.dataTransfer?.types.includes(referenceDragType);
          const fromPrompt = view.dragging?.slice.content.firstChild?.type === schema.nodes.reference;
          const pos = view.editable && (fromDock || fromPrompt) ? targetAt(view, event) : null;
          if (pos == null) { hideCursor(); return false; }
          showCursor(view, event, pos);
          if (!fromDock) return false;
          event.preventDefault(); event.dataTransfer!.dropEffect = 'copy';
          return true;
        },
        dragleave: (view, event) => {
          if (!(event.relatedTarget instanceof Node) || !view.dom.contains(event.relatedTarget)) hideCursor();
          return false;
        },
        drop: (view, event) => {
          hideCursor();
          if (event.dataTransfer?.files.length) return true; // Let the composer import native files.
          const id = event.dataTransfer?.getData(referenceDragType);
          if (!id) return false; // ProseMirror moves an existing inline node, including its selection.
          event.preventDefault(); event.stopPropagation();
          if (latest.current.disabled || !latest.current.references.some(ref => ref.id === id)) return true;
          const pos = targetAt(view, event);
          if (pos == null) return true;
          view.dispatch(view.state.tr.insert(pos, schema.node('reference', {id})));
          view.focus();
          return true;
        },
      },
      clipboardTextSerializer: slice => resolveMentions(slice.content.textBetween(0, slice.content.size, '\n', node => referenceToken(node.attrs.id)), latest.current.references),
    });
    editor.current = view;
    decorate(view);
    const doc = view.dom.ownerDocument;
    doc.addEventListener('dragend', hideCursor, true);
    doc.addEventListener('drop', hideCursor, true);
    view.dom.addEventListener('scroll', hideCursor);
    return () => {
      doc.removeEventListener('dragend', hideCursor, true);
      doc.removeEventListener('drop', hideCursor, true);
      view.dom.removeEventListener('scroll', hideCursor);
      view.destroy(); editor.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (toText(view.state.doc) !== props.value) {
      setQuery(null);
      const doc = fromText(props.value, props.references);
      // Keep the caret for asynchronous uploads and draft changes.
      const pos = Math.min(view.state.selection.head, doc.content.size - 1);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      view.updateState(view.state.apply(tr.setSelection(TextSelection.create(tr.doc,pos)).setMeta('addToHistory',false)));
    }
    view.setProps({editable: () => !props.disabled});
    decorate(view);
  }, [props.value, props.disabled, props.references]);
  return <div className="reference-prompt-wrap" data-placeholder={props.placeholder} data-empty={!props.value || undefined}>
    <div ref={mount}/>
    <span ref={caret} className="reference-drop-caret" aria-hidden="true" hidden/>
    {query && !props.disabled && props.references.length > 0 && <ModalPortal>
      <div className="reference-mention-menu" ref={menu} id={menuId} role="listbox" aria-label="选择参考图" style={menuStyle}
        onMouseDown={event => event.preventDefault()}>
        {matches.map((item, i) => <div key={item.id} id={menuId + '-' + i} role="option" aria-selected={i === selectedIndex}
          onPointerMove={() => setActiveIndex(i)} onClick={() => editor.current && chooseReference(editor.current,item.id)}>
          <img src={item.dataUrl} alt=""/><span>{item.name}</span><small>图 {props.references.indexOf(item) + 1}</small>
        </div>)}
        {!matches.length && <div className="reference-mention-empty">没有匹配的参考图</div>}
      </div>
    </ModalPortal>}
  </div>;
}
