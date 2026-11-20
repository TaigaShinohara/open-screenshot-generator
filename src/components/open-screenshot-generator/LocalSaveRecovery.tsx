"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ProjectSaveFailure } from '@/lib/projectSaveQueue';

interface Props {
  failures: readonly ProjectSaveFailure[];
  onRetry(projectId: string): Promise<void>;
  onExport(projectId: string): Promise<void>;
}

function RecoveryRow({ failure, onRetry, onExport }: Omit<Props, 'failures'> & { failure: ProjectSaveFailure }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: (projectId: string) => Promise<void>) => {
    setBusy(true);
    try {
      await action(failure.save.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1 basis-64">
        <p className="break-words text-sm font-semibold">"{failure.save.name}" could not be saved on this device</p>
        <p className="text-xs">Your edits are still in this window. Retry or export a recovery file before closing.</p>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(onRetry)}>Retry save</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(onExport)}>Export recovery file</Button>
    </div>
  );
}

export function LocalSaveRecovery({ failures, onRetry, onExport }: Props) {
  if (!failures.length) return null;
  return (
    <div role="alert" className="max-h-48 shrink-0 overflow-y-auto border-b border-destructive/40 bg-card px-4 text-foreground" data-save-recovery>
      {failures.map((failure) => <RecoveryRow key={failure.save.id} failure={failure} onRetry={onRetry} onExport={onExport} />)}
    </div>
  );
}
