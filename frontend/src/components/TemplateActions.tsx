import { useEffect, useRef, useState } from 'react';

export interface TemplateChoice {
  title: string;
  prompt: string;
  minimum: number;
  ratio: string;
  image?: string;
}
export type ChooseTemplate = (choice: TemplateChoice, onlyImage: boolean, signal: AbortSignal) => Promise<void>;

export default function TemplateActions({ choice, hasReferences, choose, close }: {
  choice: TemplateChoice; hasReferences: boolean; choose: ChooseTemplate; close: () => void;
}) {
  const [includeImage, setIncludeImage] = useState(!hasReferences);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function apply(onlyImage: boolean) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    try {
      await choose({...choice, image: onlyImage || includeImage ? choice.image : undefined}, onlyImage, controller.signal);
      if (!controller.signal.aborted) close();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <div className="template-actions">
    {choice.image && <label><input type="checkbox" checked={includeImage} disabled={busy} onChange={e => setIncludeImage(e.target.checked)} />套用时带入样图</label>}
    <div><button className="primary-button" disabled={busy || !choice.prompt.trim()} onClick={() => void apply(false)}>套用模板</button>
    {choice.image && <button className="quiet-button" disabled={busy} onClick={() => void apply(true)}>仅用作参考图</button>}</div>
    {busy && <small role="status">正在准备图片…</small>}{error && <small role="alert">{error}</small>}
  </div>;
}
