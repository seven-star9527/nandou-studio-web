import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authRequest } from '../auth';
import { useModalDialog } from '../useModalDialog';
import type { CreditUsage, StudioQuota } from '../types';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import './model-management.css';

type Model = {id: string; name: string; kind: 'cloud' | 'local'; enabled?: boolean; maxImages: number; maxReferences: number;
  maxSide?: number; maxSteps?: number; resolutions?: string[]; qualities?: string[]; ratios?: string[]; operations?: string[]; formats?: string[]; exactSize?: boolean};
type Entry = {supported: Model; policy: Model};
type Person = {id:string; name: string; email:string; quota:StudioQuota};
type Data = {models:Entry[]; users:Person[]};
const endpoint = 'admin/model-management';
const choices = { resolutions:'分辨率', ratios:'比例', qualities:'画质', operations:'操作', formats:'输出格式' } as const;
const numbers = {maxImages:'最多生成张数', maxReferences:'最多参考图', maxSide:'最长边（像素）', maxSteps:'最大步数'} as const;
const displayChoice = (item: string) => ({generate:'生图',edit:'编辑',auto:'自动',low:'低',medium:'中',high:'高',xhigh:'超高'}[item] ?? item.toUpperCase());

function ModelForm({entry, save, busy}: {entry:Entry; save:(data:object)=>void; busy:boolean}) {
  const {supported,policy} = entry;
  const [value,setValue] = useState(policy);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const {id, name: _name, kind: _kind, ...fields} = value;
    save({action:'save-model',model:id,policy:fields});
  };
  return <form className="model-management-form" onSubmit={submit}>
    <label><input type="checkbox" checked={value.enabled ?? true} onChange={e=>setValue({...value,enabled:e.target.checked})}/> 向用户开放</label>
    {Object.entries(choices).map(([raw,label])=>{
      const key = raw as keyof typeof choices;
      return !!supported[key]?.length && <fieldset key={key}><legend>{label}</legend><div className="model-management-options">
        {supported[key].map(option=><label key={option}><input type="checkbox" checked={value[key]?.includes(option) ?? false}
          onChange={e=>setValue({...value,[key]:e.target.checked ? [...(value[key] ?? []),option] : value[key]?.filter(item=>item!==option)})}/> {displayChoice(option)}</label>)}
      </div></fieldset>;
    })}
    {supported.exactSize && <label><input type="checkbox" checked={value.exactSize ?? false} onChange={e=>setValue({...value,exactSize:e.target.checked})}/> 允许自定义尺寸</label>}
    <div className="model-management-options">{Object.entries(numbers).map(([raw,label])=>{
      const key = raw as keyof typeof numbers;
      return supported[key] !== undefined && <label className="model-management-field" key={key}>{label}<input type="number" required min={key==='maxReferences'?0:key==='maxSide'?64:1} max={supported[key]} value={value[key]} onChange={e=>setValue({...value,[key]:e.target.valueAsNumber})}/></label>;
    })}</div>
    <button className="primary-button" type="submit" disabled={busy}>保存模型</button>
  </form>;
}

function LimitForm({person,models,save,busy}: {person:Person; models:Entry[]; save:(data:object)=>void; busy:boolean}) {
  const fields = (key: string, quota?: CreditUsage) => <><label className="model-management-field">总限额<input name={`${key}:total`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,8})?" defaultValue={quota?.total ?? ''} placeholder="不限"/></label>
    <label className="model-management-field">日限额<input name={`${key}:daily`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,8})?" defaultValue={quota?.daily ?? ''} placeholder="不限"/></label></>;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (key:string) => Object.fromEntries(['total','daily'].map(k=>[k,data.get(`${key}:${k}`) || null]));
    save({action:'save-limits',account:person.id,limits:{...read('account'),models:Object.fromEntries(models.map(({policy:m})=>[m.id,read(m.id)]))}});
  };
  return <form className="model-management-form" onSubmit={submit}>
    <p>按实际扣费计入积分；日限额每天北京时间 00:00 更新。</p>
    <fieldset><legend>全部模型</legend><div className="model-management-options">{fields('account',person.quota)}</div>
      <p>已用 {person.quota.used} · 今日 {person.quota.usedToday} · 在途 {person.quota.pending}</p></fieldset>
    {models.map(({policy:model})=><fieldset key={model.id}><legend>{model.name}</legend><div className="model-management-options">{fields(model.id,person.quota.models[model.id])}</div></fieldset>)}
    <button className="primary-button" type="submit" disabled={busy}>保存限额</button>
  </form>;
}

function Dialog({close}: {close:()=>void}) {
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(true,dialog,close);
  const [data,setData] = useState<Data>();
  const [section,setSection] = useState<'models'|'users'>('models');
  const [model,setModel] = useState('');
  const [user,setUser] = useState('');
  const [version,setVersion] = useState(0);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('正在读取…');
  const [failure,setFailure] = useState(false);
  const [confirm,setConfirm] = useState<'user'|'all'|null>(null);
  useEffect(()=>{
    const abort = new AbortController();
    void authRequest<Data>(endpoint,undefined,abort.signal).then(result=>{if(!abort.signal.aborted){setData(result);setMessage('');}})
      .catch(error=>{if(!abort.signal.aborted){setFailure(true);setMessage(error.message);}});
    return ()=>abort.abort();
  },[]);
  const selectedModel = data?.models.find(item=>item.policy.id===model) ?? data?.models[0];
  const person = data?.users.find(item=>item.id===user) ?? data?.users[0];
  const save = async (action:object, success='已保存') => {
    if(busy) return;
    setBusy(true);setFailure(false);setMessage('');
    try {
      await authRequest(endpoint,action);
      setConfirm(null);
      setData(await authRequest<Data>(endpoint));setVersion(n=>n+1);setMessage(success);
    } catch(error) {setFailure(true);setMessage(error instanceof Error?error.message:'操作结果未确认，请重新打开核对。');}
    finally {setBusy(false);}
  };
  return <ModalPortal><div className="modal-backdrop admin-usage-backdrop" onClick={close}>
    <section ref={dialog} className="modal admin-usage model-management" role="dialog" aria-modal="true" aria-labelledby="model-management-heading" tabIndex={-1} onClick={e=>e.stopPropagation()}>
      <div className="admin-usage-heading"><h2 id="model-management-heading">模型管理</h2><button className="icon-button" type="button" aria-label="关闭模型管理" onClick={close}><Icon name="close"/></button></div>
      <div className="model-management-options" aria-label="管理范围"><button className="quiet-button" type="button" aria-pressed={section==='models'} onClick={()=>{setSection('models');setConfirm(null);}}>模型与参数</button>
        <button className="quiet-button" type="button" aria-pressed={section==='users'} onClick={()=>{setSection('users');setConfirm(null);}}>用户限额</button></div>
      {message && <p role={failure?'alert':'status'}>{message}</p>}
      {section==='models' && selectedModel && <><label className="model-management-field">模型<select value={selectedModel.policy.id} onChange={e=>setModel(e.target.value)}>{data?.models.map(({policy:p})=><option key={p.id} value={p.id}>{p.name}{p.enabled===false?'（未开放）':''}</option>)}</select></label>
        <ModelForm key={`${selectedModel.policy.id}:${version}`} entry={selectedModel} save={action=>void save(action)} busy={busy}/></>}
      {section==='users' && data && <>
        {person ? <><label className="model-management-field">用户<select value={person.id} onChange={e=>{setUser(e.target.value);setConfirm(null);}}>{data.users.map(u=><option key={u.id} value={u.id}>{u.name?`${u.name} · `:''}{u.email}</option>)}</select></label>
        <LimitForm key={`${person.id}:${version}`} person={person} models={data.models.filter(({policy:m})=>m.kind==='cloud')} save={action=>void save(action)} busy={busy}/>
        <div className="model-management-options"><button className="quiet-button" type="button" disabled={busy} onClick={()=>setConfirm('user')}>重置当前用户</button><button className="quiet-button" type="button" disabled={busy} onClick={()=>setConfirm('all')}>重置全部用户</button></div>
        {confirm && <div className="model-management-form" role="group" aria-label="确认额度重置"><p>重置{confirm==='all'?`全部 ${data.users.length} 个用户`:person.name || person.email}的积分用量？限额设置、历史账单和在途扣费保留。</p><div className="model-management-options"><button className="primary-button" type="button" disabled={busy} onClick={()=>void save(confirm==='all'?{action:'reset-all',confirm:true}:{action:'reset-user',account:person.id},'额度已重置')}>确认重置</button><button className="quiet-button" type="button" disabled={busy} onClick={()=>setConfirm(null)}>取消</button></div></div>}</> : <p>暂无普通账号</p>}
      </>}
    </section></div></ModalPortal>;
}

export default function ModelManagement() {
  const [open,setOpen] = useState(false);
  return <><button type="button" className="official-billing-link" onClick={()=>setOpen(true)}>模型管理</button>{open && <Dialog close={()=>setOpen(false)}/>}</>;
}
