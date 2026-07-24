import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

import { api } from '../../../../utils/api';

type ApprovalPrompt = {
  title: string;
  text: string;
  canRemember: boolean;
};

type ApprovalDecision = 'approve-once' | 'approve-remember' | 'reject';

export default function ExternalCodexApprovalPrompt({
  tmuxName,
  sessionId,
}: {
  tmuxName: string;
  sessionId: string | null;
}) {
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null);
  const [sending, setSending] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await api.externalCodexSessionApproval(tmuxName, sessionId);
        if (!response.ok || cancelled) return;
        const body = await response.json().catch(() => null);
        if (cancelled) return;
        const next = body?.data?.approval;
        setApproval(
          next
          && typeof next.title === 'string'
          && typeof next.text === 'string'
            ? {
                title: next.title,
                text: next.text,
                canRemember: next.canRemember === true,
              }
            : null,
        );
      } catch {
        // Best-effort polling: ordinary transcript input remains available.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tmuxName, sessionId]);

  const respond = async (decision: ApprovalDecision) => {
    if (sending) return;
    setSending(decision);
    setError('');
    try {
      const response = await api.externalCodexSessionApprovalRespond(tmuxName, sessionId, decision);
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.data?.ok !== true) {
        setError(body?.error?.message ?? '승인 응답을 전달하지 못했습니다');
        return;
      }
      setApproval(null);
    } catch {
      setError('승인 응답을 전달하지 못했습니다');
    } finally {
      setSending(null);
    }
  };

  if (!approval) return null;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        Codex 승인 필요
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">
        {approval.text}
      </pre>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={sending !== null}
          onClick={() => void respond('approve-once')}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {sending === 'approve-once' ? '전달 중…' : '이번만 승인'}
        </button>
        {approval.canRemember && (
          <button
            type="button"
            disabled={sending !== null}
            onClick={() => void respond('approve-remember')}
            className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300"
          >
            {sending === 'approve-remember' ? '전달 중…' : '이 명령 계열 계속 허용'}
          </button>
        )}
        <button
          type="button"
          disabled={sending !== null}
          onClick={() => void respond('reject')}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          {sending === 'reject' ? '전달 중…' : '거부'}
        </button>
      </div>
    </div>
  );
}
