import { useCallback, useEffect, useRef, useState } from 'react';
import type { SwarmClient } from './api';
import { cloudJobUpdate, cloudTaskNeedsReadback, taskArtworks } from './cloud-contract';
import { mergeJobProgress } from './job-progress';
import type { Artwork, CloudAccount, CloudCapabilities, CloudRequest, CloudTask, Job } from './types';

export function useCloudStudio(client: SwarmClient, receiveArtwork: (artwork: Artwork) => void) {
  const [capabilities, setCapabilities] = useState<CloudCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const accountSequence = useRef(0);
  const accountAbort = useRef<AbortController | null>(null);
  const completedAccountRefresh = useRef(new Set<string>());
  const pollTimer = useRef<number | undefined>(undefined);
  const active = useRef<Job | null>(null);
  const hidden = useRef(new Set<string>());
  const waiting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; window.clearTimeout(pollTimer.current); accountAbort.current?.abort(); }; }, []);
  const loadAccount = useCallback(async () => {
    if (!mounted.current) return;
    const revision = ++accountSequence.current;
    accountAbort.current?.abort();
    const controller = new AbortController(); accountAbort.current = controller;
    setAccountLoading(true); setAccountError('');
    try {
      const value = await client.cloudAccount(controller.signal);
      if (mounted.current && revision === accountSequence.current) { setAccount(value); setAccountError(''); }
    } catch (error) {
      if (mounted.current && revision === accountSequence.current && !controller.signal.aborted) { setAccount(null); setAccountError(error instanceof Error ? error.message : String(error)); }
    } finally { if (mounted.current && revision === accountSequence.current) setAccountLoading(false); }
  }, [client]);
  const loadCapabilities = useCallback(async () => {
    try { const value = await client.cloudCapabilities(); if (mounted.current) { setCapabilities(value); setCapabilityError(''); void loadAccount(); } }
    catch (error) { if (mounted.current) setCapabilityError(error instanceof Error ? error.message : String(error)); }
  }, [client, loadAccount]);
  const acceptTask = useCallback((task: CloudTask) => {
    if (!mounted.current || hidden.current.has(task.studio_task_id ?? task.request_id)) return;
    setTasks(previous => [task, ...previous.filter(item => item.request_id !== task.request_id)]);
    for (const artwork of taskArtworks(task, active.current?.id === task.request_id)) receiveArtwork(artwork);
    if (active.current?.id === task.request_id) {
      active.current = mergeJobProgress(active.current, cloudJobUpdate(task, active.current.requested, waiting.current));
      setJob(active.current);
      if (['completed', 'failed', 'cancelled'].includes(task.status) && !completedAccountRefresh.current.has(task.request_id)) {
        completedAccountRefresh.current.add(task.request_id); void loadAccount();
      }
    }
  }, [receiveArtwork, loadAccount]);
  const refreshTasks = useCallback(async () => {
    const values = await client.cloudTasks();
    const latest = new Map(values.map(task => [task.request_id, task]));
    if (mounted.current) setTasks(values.filter(task => !hidden.current.has(task.studio_task_id ?? task.request_id)));
    for (const task of values.slice().sort((a, b) => Date.parse(a.created_utc) - Date.parse(b.created_utc))) acceptTask(task);
    // Status reads may finish delivery/cache recovery, but never create another paid request.
    const pending = values.filter(cloudTaskNeedsReadback);
    let readFailures = 0;
    for (let offset = 0; offset < pending.length; offset += 4) {
      const results = await Promise.allSettled(pending.slice(offset, offset + 4).map(task => client.cloudTask(task.request_id)));
      for (const result of results) if (result.status === 'fulfilled') { latest.set(result.value.request_id, result.value); acceptTask(result.value); } else readFailures++;
    }
    void loadAccount();
    if (readFailures) throw new Error(`${readFailures} 个云任务的状态尚未确认，请稍后刷新记录。不会重新提交生成。`);
    return [...latest.values()].filter(task => !hidden.current.has(task.studio_task_id ?? task.request_id));
  }, [client, acceptTask, loadAccount]);
  const generate = async (request: CloudRequest) => {
    window.clearTimeout(pollTimer.current);
    active.current = { id: request.request_id, started: Date.now(), requested: request.n, completed: 0, phase: 'connecting', source: 'cloud' };
    waiting.current = true;
    setJob(active.current);
    const poll = async () => {
      try {
        const task = await client.cloudTask(request.request_id);
        acceptTask(task);
        if (mounted.current && waiting.current && active.current?.id === request.request_id && ['uploading', 'submitting', 'submitted', 'pending', 'processing'].includes(task.status)) pollTimer.current = window.setTimeout(poll, 2500);
      } catch (error) {
        if (mounted.current && active.current?.id === request.request_id) {
          active.current = { ...active.current, phase: 'unknown', error: `状态读取失败，后台任务可能继续：${error instanceof Error ? error.message : String(error)}` };
          setJob(active.current);
        }
      }
    };
    try { await client.submitCloud(request); }
    catch (error) {
      if (mounted.current && active.current?.id === request.request_id) {
        active.current = { ...active.current, phase: 'unknown', error: `提交未确认，将按请求编号读取结果：${error instanceof Error ? error.message : String(error)}` };
        setJob(active.current);
      }
    }
    // Creation is never retried. The same request ID is only used for readback.
    await poll();
  };
  const stopWaiting = () => {
    waiting.current = false;
    window.clearTimeout(pollTimer.current);
    if (active.current) { active.current = { ...active.current, phase: 'background', percent: undefined, error: undefined }; setJob(active.current); }
  };
  const dismissTask = (id: string) => {
    hidden.current.add(id);
    setTasks(previous => previous.filter(task => (task.studio_task_id ?? task.request_id) !== id));
    if (active.current?.id === id) { window.clearTimeout(pollTimer.current); active.current = null; waiting.current = false; setJob(null); }
  };
  return { capabilities, capabilityError, tasks, job, account, accountLoading, accountError, loadAccount, loadCapabilities, refreshTasks, generate, stopWaiting, dismissTask };
}
