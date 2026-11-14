import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { DOMSerializer, Schema, type Node as DocNode } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { ReferenceImage } from '../types';
import { mentionParts, referenceDragType, referenceToken, resolveMentions } from '../reference-mentions';
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
export interface PromptEditorHandle { focus(): void; selectText(text: string): void }
interface Props {
  editorRef?: Ref<PromptEditorHandle>; label: string; value: string; references: ReferenceImage[];
  placeholder: string; disabled?: boolean; change(value: string): void; submit(text: string): void; enterToSend?: boolean;
}
export default function PromptEditor(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
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
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Enter' || event.isComposing || view.composing || event.keyCode === 229) return false;
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
        paste: (view, event) => {
          if (Array.from(event.clipboardData?.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) return true; // Dock handles the image at document level.
          const text = event.clipboardData?.getData('text/plain');
          event.preventDefault();
          if (text) view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g,'\n')).scrollIntoView());
          return true;
        },
        dragover: (_, event) => {
          if (!event.dataTransfer?.types.includes(referenceDragType)) return false;
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
          return true;
        },
        drop: (view, event) => {
          if (event.dataTransfer?.files.length) return true; // Let the composer import native files.
          const id = event.dataTransfer?.getData(referenceDragType);
          if (!id) return false; // ProseMirror moves an existing inline node, including its selection.
          event.preventDefault(); event.stopPropagation();
          if (latest.current.disabled || !latest.current.references.some(ref => ref.id === id)) return true;
          const pos = view.posAtCoords({left:event.clientX, top:event.clientY})?.pos ?? view.state.doc.content.size - 1;
          view.dispatch(view.state.tr.insert(pos, schema.node('reference', {id})));
          view.focus();
          return true;
        },
      },
      clipboardTextSerializer: slice => resolveMentions(slice.content.textBetween(0, slice.content.size, '\n', node => referenceToken(node.attrs.id)), latest.current.references),
    });
    editor.current = view;
    decorate(view);
    return () => {view.destroy(); editor.current = null;};
  }, []);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (toText(view.state.doc) !== props.value) {
      const doc = fromText(props.value, props.references);
      // Keep the caret for asynchronous uploads and draft changes.
      const pos = Math.min(view.state.selection.head, doc.content.size - 1);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      view.updateState(view.state.apply(tr.setSelection(TextSelection.create(tr.doc,pos)).setMeta('addToHistory',false)));
    }
    view.setProps({editable: () => !props.disabled});
    decorate(view);
  }, [props.value, props.disabled, props.references]);
  return <div className="reference-prompt-wrap" data-placeholder={props.placeholder} data-empty={!props.value || undefined} ref={mount}/>;
}
