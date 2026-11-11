import { useEffect, useState } from 'react';
import './task-references.css';

import { listTaskReferences } from '../task-references';

export default function TaskReferences({ taskId }: { taskId: string }) {
  const [state, setState] = useState<{ taskId: string; references?: Awaited<ReturnType<typeof listTaskReferences>>; error?: string }>({ taskId });
  useEffect(() => {
    const abort = new AbortController();
    setState({ taskId });
    void listTaskReferences(taskId, abort.signal)
      .then(references => {
        if (!abort.signal.aborted) setState({ taskId, references });
      }).catch(error => { if (!abort.signal.aborted) setState({ taskId, error: error instanceof Error ? error.message : '参考原图读取失败。' }); });
    return () => abort.abort();
  }, [taskId]);
  const current = state.taskId === taskId ? state : { taskId };
  return <section className="task-references" aria-label="任务参考原图"><h3>参考原图</h3>
    {current.error ? <p role="alert">{current.error}</p> : !current.references ? <p role="status">正在读取参考图…</p>
      : current.references.length ? <div className="task-reference-list">{current.references.map(item => <a key={item.index} href={item.url} target="_blank" rel="noreferrer" aria-label={`查看参考原图 ${item.index}`}>
        <img src={item.url} alt={`参考原图 ${item.index}`} loading="lazy" /><span>参考图 {item.index} · {item.width} × {item.height}</span>
      </a>)}</div> : <p>此任务未保存参考原图。旧记录仅保留参考图尺寸时，无法在这里还原。</p>}
  </section>;
}
