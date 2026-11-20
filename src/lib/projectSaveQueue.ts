import type { ArtboardState } from '@/types/artboard';

export const PROJECT_SAVE_DELAY_MS = 600;

export interface ProjectSave {
  id: string;
  name: string;
  artboards: ArtboardState[];
}

export interface ProjectSaveFailure {
  save: ProjectSave;
  error: unknown;
}

export const NO_PROJECT_SAVE_FAILURES: readonly ProjectSaveFailure[] = Object.freeze([]);

export interface ProjectSaveQueue {
  schedule(save: ProjectSave): void;
  flush(): Promise<void>;
  flushOtherThan(projectId: string): Promise<void>;
  retry(projectId: string): Promise<void>;
  drop(projectId: string): void;
  getPending(projectId: string): ProjectSave | undefined;
  hasPending(projectId?: string): boolean;
  getFailures(): readonly ProjectSaveFailure[];
  subscribe(listener: () => void): () => void;
}

interface PendingSave {
  save: ProjectSave;
  revision: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  failure: ProjectSaveFailure | null;
}

/** Debounce edits per project and retain the latest document until its write succeeds. */
export function createProjectSaveQueue(
  write: (save: ProjectSave) => Promise<unknown>,
  delayMs: number = PROJECT_SAVE_DELAY_MS
): ProjectSaveQueue {
  const pending = new Map<string, PendingSave>();
  const listeners = new Set<() => void>();
  let failures = NO_PROJECT_SAVE_FAILURES;

  const notify = () => {
    const next = [...pending.values()].flatMap((entry) => entry.failure ? [{ ...entry.failure, save: entry.save }] : []);
    if (!next.length && !failures.length) return;
    failures = next.length ? next : NO_PROJECT_SAVE_FAILURES;
    listeners.forEach((listener) => listener());
  };
  const clearTimer = (entry: PendingSave) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  };
  const start = (entry: PendingSave): Promise<void> => {
    clearTimer(entry);
    if (entry.running) return entry.running;
    const { save, revision } = entry;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(write(save));
    } catch (error) {
      result = Promise.reject(error);
    }
    const running = result.then(
      () => {
        if (pending.get(save.id) === entry && entry.revision === revision) pending.delete(save.id);
      },
      (error) => {
        if (pending.get(save.id) === entry) entry.failure = { save: entry.save, error };
        throw error;
      }
    ).finally(() => {
      entry.running = null;
      notify();
    });
    entry.running = running;
    return running;
  };
  const drain = async (include: (id: string) => boolean): Promise<void> => {
    for (;;) {
      const entries = [...pending.entries()].filter(([id]) => include(id));
      if (!entries.length) return;
      await Promise.all(entries.map(([, entry]) => start(entry)));
    }
  };
  const observedDrain = (include: (id: string) => boolean) => {
    const result = drain(include);
    // Timers and unload events cannot await a failure. Awaiting callers still receive it.
    void result.catch(() => {});
    return result;
  };

  return {
    schedule(save) {
      // A project switch writes other debounced rows, but never retries a failed row unattended.
      for (const [id, entry] of pending) {
        if (id !== save.id && entry.timer !== null && !entry.failure) void start(entry).catch(() => {});
      }
      let entry = pending.get(save.id);
      if (entry) {
        clearTimer(entry);
        entry.save = save;
        entry.revision += 1;
      } else {
        entry = { save, revision: 0, timer: null, running: null, failure: null };
        pending.set(save.id, entry);
      }
      const scheduled = entry;
      entry.timer = setTimeout(() => {
        void start(scheduled).then(() => {
          if (pending.get(save.id) === scheduled && !scheduled.failure && scheduled.timer === null) {
            void start(scheduled).catch(() => {});
          }
        }).catch(() => {});
      }, delayMs);
      notify();
    },
    flush: () => observedDrain(() => true),
    flushOtherThan: (projectId) => observedDrain((id) => id !== projectId),
    retry: (projectId) => observedDrain((id) => id === projectId),
    drop(projectId) {
      const entry = pending.get(projectId);
      if (!entry) return;
      clearTimer(entry);
      pending.delete(projectId);
      notify();
    },
    getPending: (projectId) => pending.get(projectId)?.save,
    hasPending: (projectId) => projectId ? pending.has(projectId) : pending.size > 0,
    getFailures: () => failures,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
