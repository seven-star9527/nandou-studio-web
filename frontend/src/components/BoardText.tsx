import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Schema, type NodeSpec } from 'prosemirror-model';
import { schema as basic } from 'prosemirror-schema-basic';
import { EditorState, Plugin, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { addListNodes, liftListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import 'prosemirror-view/style/prosemirror.css';

const aligned = (heading:boolean):NodeSpec => ({
  content:'inline*', group:'block', defining:heading,
  attrs:heading?{level:{default:1},align:{default:'left'}}:{align:{default:'left'}},
  parseDOM:(heading?[1,2,3]:[0]).map(level=>({tag:level?'h'+level:'p',getAttrs:(el:HTMLElement)=>({
    ...(level?{level}:{}),align:['center','right'].includes(el.style.textAlign)?el.style.textAlign:'left'
  })})),
  toDOM:node=>[heading?'h'+node.attrs.level:'p',{style:'text-align:'+node.attrs.align},0],
});
const nodes=basic.spec.nodes.remove('image').remove('code_block').remove('horizontal_rule')
  .update('paragraph',aligned(false)).update('heading',aligned(true));
const schema=new Schema({
  nodes:addListNodes(nodes,'paragraph block*','block'),
  marks:basic.spec.marks.remove('link').remove('code')
    .addToEnd('underline',{parseDOM:[{tag:'u'}],toDOM:()=>['u',0]})
    .addToEnd('strike',{parseDOM:[{tag:'s'},{tag:'del'}],toDOM:()=>['s',0]}),
});
export interface RichText { type:string; text?:string; attrs?:Record<string,unknown>; content?:RichText[]; marks?:{type:string}[] }
function documentFrom(text:string,rich?:RichText) {
  if(rich)try{const doc=schema.nodeFromJSON(rich);doc.check();return doc;}catch{/* Read the legacy plain text if rich data cannot be opened. */}
  return schema.node('doc',null,text.split('\n').map(line=>schema.node('paragraph',null,line?schema.text(line):undefined)));
}
function hasAncestor(view:EditorView,name:string) {
  const pos=view.state.selection.$from;
  for(let level=pos.depth;level>0;level--)if(pos.node(level).type.name===name)return true;
  return false;
}
export default function BoardText({text,rich,paper,editing,change,host,style}:{
  text:string;rich?:RichText;paper?:string;editing:boolean;change:(text:string,rich:RichText)=>void;
  host:HTMLElement|null;style:CSSProperties;
}) {
  const mount=useRef<HTMLDivElement>(null),editor=useRef<EditorView|null>(null);
  const props=useRef({change,text,rich}); props.current={change,text,rich};
  const [,refresh]=useState(0);
  useLayoutEffect(()=>{
    const current=props.current;
    const view=new EditorView(mount.current!,{
      state:EditorState.create({doc:documentFrom(current.text,current.rich),plugins:[
        history(),keymap({'Mod-a':(state,dispatch)=>{
          dispatch?.(state.tr.setSelection(TextSelection.between(state.doc.resolve(0),state.doc.resolve(state.doc.content.size))));return true;
        },'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Mod-u':toggleMark(schema.marks.underline),
          'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,Enter:splitListItem(schema.nodes.list_item)}),keymap(baseKeymap),
        new Plugin({filterTransaction:tr=>!tr.docChanged || (tr.doc.textBetween(0,tr.doc.content.size,'\n').length<=4000 && JSON.stringify(tr.doc.toJSON()).length<=20000 && tr.doc.resolve(tr.selection.from).depth<=18)})]}),
      editable:()=>editing,attributes:{'aria-label':'文本内容',role:'textbox','aria-multiline':'true'},
      dispatchTransaction(tr){
        const next=view.state.apply(tr);view.updateState(next);
        if(next.doc!==tr.before)props.current.change(next.doc.textBetween(0,next.doc.content.size,'\n'),next.doc.toJSON());
        if(editing)refresh(n=>n+1);
      },
    });
    editor.current=view;
    if(editing){view.focus();refresh(n=>n+1);}
    return ()=>{view.destroy();editor.current=null;};
  },[editing]);
  const view=editor.current;
  function run(cmd:Command) {if(view){cmd(view.state,view.dispatch,view);view.focus();}}
  function button(label:string,glyph:string,cmd:Command,active=false) {
    return <button type="button" key={label} title={label} aria-label={label} aria-pressed={active} onMouseDown={e=>e.preventDefault()} onClick={()=>run(cmd)}>{glyph}</button>;
  }
  function align(value:string) {
    if(!view)return;
    const {state}=view,{from,to}=state.selection,tr=state.tr;
    state.doc.nodesBetween(from,to,(node,pos)=>{if(node.isTextblock)tr.setNodeMarkup(pos,undefined,{...node.attrs,align:value});});
    view.dispatch(tr);view.focus();
  }
  const block=view?.state.selection.$from.parent;
  return <><div className={'board-text'+(editing?' editing':'')} ref={mount} data-paper={paper} data-empty={!text || undefined}/>
    {editing&&view&&host&&createPortal(<div className="selection-bar board-format" role="toolbar" aria-label="文本格式" onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} style={style}>
      <select aria-label="文本样式" value={block?.type===schema.nodes.heading?String(block.attrs.level):'0'} onChange={e=>{const level=Number(e.target.value);run(setBlockType(level?schema.nodes.heading:schema.nodes.paragraph,{...(level?{level}:{}),align:block?.attrs.align}));}}>
        <option value="0">正文</option>{[1,2,3].map(n=><option key={n} value={n}>标题 {n}</option>)}</select>
      {(['bullet_list','ordered_list'] as const).map((type,i)=>button(i?'编号列表':'项目列表',i?'1.':'•',hasAncestor(view,type)?liftListItem(schema.nodes.list_item):wrapInList(schema.nodes[type]),hasAncestor(view,type)))}
      {button('引用','❝',hasAncestor(view,'blockquote')?lift:wrapIn(schema.nodes.blockquote),hasAncestor(view,'blockquote'))}
      <select aria-label="文本对齐" value={block?.attrs.align||'left'} onChange={e=>align(e.target.value)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select>
      {([['strong','粗体','B'],['em','斜体','𝑰'],['underline','下划线','U̲'],['strike','删除线','S̶']] as const).map(([key,label,glyph])=>{
        const {from,to,$from,empty}=view.state.selection;
        const active=empty?schema.marks[key].isInSet(view.state.storedMarks??$from.marks()):view.state.doc.rangeHasMark(from,to,schema.marks[key]);
        return button(label,glyph,toggleMark(schema.marks[key]),!!active);
      })}
      {button('撤销文本编辑','↶',undo)}{button('重做文本编辑','↷',redo)}
    </div>,host)}</>;
}
