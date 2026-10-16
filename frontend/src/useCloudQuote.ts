import { useEffect, useRef, useState } from 'react';
import type { SwarmClient } from './api';
import { quoteForSelection, quoteKey, quoteRequest } from './credit-contract';
import type { CloudModelCapability, CloudQuote, GenerationSettings } from './types';

export function useCloudQuote(client: SwarmClient, connected: boolean, model: CloudModelCapability | undefined, settings: GenerationSettings) {
  const request = model ? quoteRequest(model.id, settings) : null;
  const key = request ? quoteKey(request) : '';
  const [record, setRecord] = useState<{ key: string; quote: CloudQuote } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const sequence = useRef(0);
  const latestRequest = useRef(request);
  latestRequest.current = request;
  useEffect(() => {
    const revision = ++sequence.current;
    const input = latestRequest.current;
    if (!connected || !input) { setLoading(false); setFailure(null); return; }
    const controller = new AbortController();
    setLoading(true); setFailure(null);
    const timer = window.setTimeout(() => {
      client.cloudQuote(input, controller.signal).then(quote => {
        if (revision !== sequence.current || controller.signal.aborted) return;
        if (quote.model !== input.model) throw new Error('报价模型与当前选择不一致，请刷新连接。');
        setRecord({ key, quote });
      }).catch(cause => {
        if (revision === sequence.current && !controller.signal.aborted) { setRecord(null); setFailure({ key, message: cause instanceof Error ? cause.message : String(cause) }); }
      }).finally(() => { if (revision === sequence.current && !controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [client, connected, key]);
  return { quote: model && connected ? quoteForSelection(record, key, model.id) : null,
    loading: Boolean(model && connected && (loading || (record && record.key !== key))), error: failure?.key === key ? failure.message : '' };
}
