// Automatic updates require the Settings switch and a project-specific consent
// recorded by a manual cloud save or by opening the owner's cloud copy.
// IndexedDB remains the working copy; this saver only pushes and never merges.

import { getCloudLink, hasCloudAutoSaveConsent } from './links';
import { CloudAutoSaveConsentRequiredError, CloudConflictError, saveProjectToCloud } from './index';
import {
  CloudDisabledError,
  CloudRequestError,
  CloudSignInRequiredError,
  type CloudProject,
} from './types';

const QUIET_MS = 5_000;
const MAX_DEFER_MS = 30_000;
const MIN_GAP_MS = 8_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/** Offline is not a failure worth backing off over, it is a wait. */
const OFFLINE_RETRY_MS = 20_000;

export type CloudAutoSaveState =
  /** No backend, the operator switched cloud projects off, or the user did. */
  | 'disabled'
  /** There is nobody to attribute a save to. */
  | 'signed-out'
  /** This project has no permission for automatic cloud updates. */
  | 'unlinked'
  /** Armed, with nothing that needs pushing yet. */
  | 'waiting'
  /** Edits are waiting for the threshold. */
  | 'pending'
  | 'saving'
  | 'saved'
  /** A push failed on something that might work next time. */
  | 'retrying'
  /** Stopped until somebody answers something. */
  | 'paused';

export interface CloudAutoSaveStatus {
  state: CloudAutoSaveState;
  /** When the cloud copy was last written, from this device. */
  savedAt: number | null;
  /** Why it is paused or retrying, ready to put in front of somebody. */
  message: string | null;
  /** The remote row a conflict is with, so the UI can open its dialog. */
  conflict: CloudProject | null;
  /** Blobs the last push could not upload. The next one retries exactly these. */
  pendingAssets: number;
}

/**
 * The snapshot before anything has been configured.
 *
 * Frozen and shared because `useSyncExternalStore` compares snapshots by
 * identity: a fresh object per read would re-render the chip on every commit of
 * the whole editor.
 */
export const IDLE_AUTO_SAVE_STATUS: CloudAutoSaveStatus = Object.freeze({
  state: 'disabled',
  savedAt: null,
  message: null,
  conflict: null,
  pendingAssets: 0,
});

export interface CloudAutoSaveConfig {
  /** The local project id, or null when nothing is open. */
  projectId: string | null;
  /** Which community account the copy would belong to. */
  accountId: string | null;
  /** This build has a backend AND the box has cloud projects switched on. */
  available: boolean;
  signedIn: boolean;
  /** The user's own switch, from Settings. */
  enabled: boolean;
  /**
   * Bumped every time a project is opened, imported or created.
   *
   * The id alone is not enough to notice that: restoring the cloud copy of the
   * project that is already open keeps the same id, and without this the saver
   * would carry its pause, its backoff and its "unsaved" flag across an open
   * that answered the very thing it was stuck on.
   */
  openToken: number;
}

const BLANK_CONFIG: CloudAutoSaveConfig = {
  projectId: null,
  accountId: null,
  available: false,
  signedIn: false,
  enabled: false,
  openToken: 0,
};

/** Why a push is being attempted. Only `manual` overrides a pause. */
type PushReason = 'threshold' | 'manual' | 'hidden';

export interface CloudAutoSaverOptions {
  /**
   * Commit the debounced local write first.
   *
   * `saveProjectToCloud` reads the stored Dexie row, and the editor's own save
   * is 600ms behind the canvas, so without this a push would routinely carry the
   * document as it was one keystroke ago.
   */
  flushLocal: () => Promise<unknown> | void;
}

export class CloudAutoSaver {
  private readonly options: CloudAutoSaverOptions;
  private config: CloudAutoSaveConfig = BLANK_CONFIG;
  private status: CloudAutoSaveStatus = IDLE_AUTO_SAVE_STATUS;
  private readonly listeners = new Set<() => void>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;
  private inFlight = false;
  /** Stopped until a person acts. Only `saveNow` clears it. */
  private paused = false;
  private pausedStatus: Pick<CloudAutoSaveStatus, 'message' | 'conflict'> | null = null;

  private dirty = false;
  /** The first unsaved change since the last push, for the MAX_DEFER ceiling. */
  private dirtySince = 0;
  private lastChangeAt = 0;
  private lastPushAt = 0;
  private hasCloudCopy = false;
  /** False until the link table has answered, so the first push is not blind. */
  private linkChecked = false;
  private failures = 0;
  private retryAt = 0;
  /** Bumped on every arm, so a slow link read cannot land on the next project. */
  private linkToken = 0;

  constructor(options: CloudAutoSaverOptions) {
    this.options = options;
  }

  // --- what the UI reads ----------------------------------------------------

  getStatus = (): CloudAutoSaveStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // --- what the editor tells it ---------------------------------------------

  /**
   * The open project, the account, and whether any of this is switched on.
   *
   * Called on every change to those, which includes signing in and out. A change
   * of project (or of account) re-arms from scratch; anything else only
   * recomputes which state the chip should be showing.
   */
  configure(next: CloudAutoSaveConfig): void {
    const previous = this.config;
    this.config = next;
    if (
      previous.projectId !== next.projectId ||
      previous.accountId !== next.accountId ||
      previous.openToken !== next.openToken
    ) {
      this.arm();
    } else {
      this.settle();
    }
    this.reschedule();
  }

  /**
   * A commit landed on the open project.
   *
   * Cheap on purpose: this runs once per commit, and a drag commits per pixel.
   * It moves two numbers and re-arms one timer.
   */
  noteChange(projectId: string | null): void {
    if (!projectId || projectId !== this.config.projectId) return;
    const now = Date.now();
    this.lastChangeAt = now;
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = now;
    }
    // Neither a running push nor a backoff nor a pause is displaced by an edit:
    // the first will notice this change when it finishes, the second is already
    // counting, and the third is waiting for a person.
    if (!this.paused && this.status.state !== 'saving' && this.status.state !== 'retrying') {
      this.setStatus({ state: this.resolveIdleState('pending') });
    }
    this.reschedule();
  }

  /**
   * Somebody saved this project by hand, or resolved a conflict.
   *
   * Read the stored consent, revision and remaining uploads. The project id
   * keeps a save that finished after a switch from arming the next project.
   */
  noteSaved(projectId: string): void {
    if (projectId !== this.config.projectId) return;
    this.arm(true);
  }

  /** The chip's retry: clears a pause or a backoff and pushes right now. */
  saveNow(): void {
    this.paused = false;
    this.pausedStatus = null;
    this.failures = 0;
    this.retryAt = 0;
    void this.push('manual');
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Two listeners, both of which exist to save work that would otherwise wait.
   *
   * `visibilitychange` is the one that matters: switching tab or app is the most
   * common way an editing session ends, and a push started there still has time
   * to finish. `pagehide` deliberately gets nothing, because a request killed
   * mid flight can still land on the server while this device never records that
   * it did, and the next save would then report a conflict with itself.
   */
  attach(): void {
    if (this.attached || typeof document === 'undefined') return;
    this.attached = true;
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('online', this.handleOnline);
  }

  detach(): void {
    if (this.attached && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
      window.removeEventListener('online', this.handleOnline);
    }
    this.attached = false;
    this.clearTimer();
  }

  private handleVisibility = (): void => {
    if (document.visibilityState !== 'hidden') return;
    if (!this.dirty) return;
    void this.push('hidden');
  };

  private handleOnline = (): void => {
    if (this.status.state !== 'retrying') return;
    // Back on a connection, so the remaining backoff is about a network that is
    // no longer the problem. Try again shortly rather than immediately, since
    // `online` fires before a captive portal or a VPN has actually settled.
    this.retryAt = Date.now() + 2_000;
    this.reschedule();
  };

  // --- the schedule ---------------------------------------------------------

  /** When the next push is due, or null when there is nothing to push. */
  private dueAt(): number | null {
    const { projectId, available, signedIn, enabled } = this.config;
    if (!projectId || !available || !signedIn || !enabled) return null;
    if (this.paused || this.inFlight) return null;
    if (!this.linkChecked || !this.hasCloudCopy) return null;

    let due: number;
    if (this.dirty) {
      // Quiet since the last edit, but never later than the ceiling measured
      // from the FIRST unsaved one: that is what keeps a long uninterrupted
      // editing session from deferring the push forever.
      due = Math.min(this.lastChangeAt + QUIET_MS, this.dirtySince + MAX_DEFER_MS);
    } else {
      return null;
    }
    return Math.max(due, this.lastPushAt + MIN_GAP_MS, this.retryAt, Date.now());
  }

  private reschedule(): void {
    this.clearTimer();
    const due = this.dueAt();
    if (due === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push('threshold');
    }, Math.max(0, due - Date.now()));
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // --- arming ---------------------------------------------------------------

  /**
   * Start again for whatever is open now.
   *
   * The link read is what tells this whether the project is already in the
   * cloud, when it last got there, and whether the last push left blobs behind.
   * Any of the three changes what happens next, so the first push waits for it.
   */
  private arm(keepChanges = false): void {
    this.clearTimer();
    this.paused = false;
    this.pausedStatus = null;
    // A manual request can finish after another edit. Keeping those edits may
    // resend the document once, but prevents a newer edit being marked saved.
    if (!keepChanges) {
      this.dirty = false;
      this.dirtySince = 0;
      this.lastChangeAt = 0;
    }
    this.lastPushAt = 0;
    this.hasCloudCopy = false;
    this.linkChecked = false;
    this.failures = 0;
    this.retryAt = 0;
    this.setStatus({ ...IDLE_AUTO_SAVE_STATUS, state: this.resolveIdleState() });

    const { projectId, accountId } = this.config;
    const token = ++this.linkToken;
    if (!projectId) return;

    void getCloudLink(projectId, accountId).then((link) => {
      // A project switch during the read makes this answer somebody else's.
      if (token !== this.linkToken) return;
      this.linkChecked = true;
      if (hasCloudAutoSaveConsent(link, accountId)) {
        this.hasCloudCopy = true;
        const savedAt = link.savedAt instanceof Date ? link.savedAt.getTime() : 0;
        this.lastPushAt = savedAt;
        this.setStatus({ state: this.resolveIdleState(this.dirty ? 'pending' : 'saved'), savedAt: savedAt || null });
        if (link.pendingAssets?.length) {
          // The last push got the document up and lost some of its files. That
          // is unfinished work, so it counts as dirty and the next push carries
          // exactly what is missing.
          this.dirty = true;
          this.dirtySince = Date.now();
          this.lastChangeAt = Date.now();
          this.setStatus({ state: this.resolveIdleState('pending'), pendingAssets: link.pendingAssets.length });
        }
      } else {
        this.setStatus({ state: this.resolveIdleState() });
      }
      this.reschedule();
    }).catch(() => {
      // An unreadable consent record cannot authorize an automatic update.
      if (token !== this.linkToken) return;
      this.linkChecked = true;
      this.setStatus({ state: this.resolveIdleState() });
      this.reschedule();
    });
  }

  /**
   * The state to show when nothing is happening.
   *
   * "Disabled" and "signed out" outrank everything: with either of them true
   * there is no cloud copy to describe, and the chip says so rather than
   * claiming a project is saved.
   */
  private resolveIdleState(preferred: CloudAutoSaveState = 'waiting'): CloudAutoSaveState {
    const { available, enabled, signedIn, accountId } = this.config;
    if (!available || !enabled) return 'disabled';
    if (!signedIn || !accountId) return 'signed-out';
    if (!this.linkChecked || !this.hasCloudCopy) return 'unlinked';
    return preferred;
  }

  /** Re-read the config into the current state, without re-arming. */
  private settle(): void {
    const { available, enabled, signedIn, accountId } = this.config;
    if (!available || !enabled) {
      this.setStatus({ state: 'disabled', message: null, conflict: null });
      return;
    }
    if (!signedIn || !accountId) {
      this.setStatus({ state: 'signed-out', message: null, conflict: null });
      return;
    }
    if (!this.linkChecked || !this.hasCloudCopy) {
      this.setStatus({ state: 'unlinked', message: null, conflict: null });
      return;
    }
    if (this.paused) {
      this.setStatus({ state: 'paused', ...this.pausedStatus });
      return;
    }
    if (this.status.state !== 'disabled' && this.status.state !== 'signed-out' && this.status.state !== 'unlinked') return;
    // Just signed in, or just switched on: pick up where the project stands.
    this.setStatus({
      state: this.dirty ? 'pending' : this.status.savedAt ? 'saved' : 'waiting',
      message: null,
    });
  }

  // --- the push -------------------------------------------------------------

  private async push(reason: PushReason): Promise<void> {
    const { projectId, accountId, available, signedIn, enabled } = this.config;
    if (!projectId || !available || !signedIn || !enabled) return;
    if (!accountId || !this.linkChecked || !this.hasCloudCopy) return;
    if (this.inFlight) return;
    if (this.paused && reason !== 'manual') return;
    // A manual retry can resend an unchanged, authorized project.
    if (!this.dirty && this.hasCloudCopy && reason !== 'manual') return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.retryAt = Date.now() + OFFLINE_RETRY_MS;
      this.setStatus({ state: 'retrying', message: 'Waiting for a connection' });
      this.reschedule();
      return;
    }

    this.inFlight = true;
    this.clearTimer();
    // Read before the await: an edit that arrives while the upload is running
    // is NOT covered by it, and comparing against this mark is how the next
    // schedule knows that.
    const changeMark = this.lastChangeAt;
    const token = this.linkToken;
    this.setStatus({ state: 'saving', message: null });

    try {
      await this.options.flushLocal();
      if (token !== this.linkToken || !this.config.available || !this.config.enabled || !this.config.signedIn) return;
      const { failedAssets } = await saveProjectToCloud(projectId, { origin: 'auto' });
      if (token !== this.linkToken) return;

      this.lastPushAt = Date.now();
      this.hasCloudCopy = true;
      this.linkChecked = true;
      this.dirty = this.lastChangeAt > changeMark || failedAssets.length > 0;
      if (this.dirty) this.dirtySince = Math.max(this.lastChangeAt, this.lastPushAt);
      if (failedAssets.length > 0) {
        // The document landed and some of its files did not, which is worth
        // retrying but not at the ordinary gap: a recording the box keeps
        // refusing would otherwise re-upload the whole document every 25s for
        // as long as the project stays open. Same growing delay a failure gets.
        this.failures += 1;
        this.retryAt = Date.now() + BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
      } else {
        this.failures = 0;
        this.retryAt = 0;
      }
      this.setStatus({
        state: this.dirty ? 'pending' : 'saved',
        savedAt: this.lastPushAt,
        message: null,
        conflict: null,
        pendingAssets: failedAssets.length,
      });
    } catch (error) {
      if (token !== this.linkToken) return;
      this.handleFailure(error);
    } finally {
      this.inFlight = false;
      this.reschedule();
    }
  }

  private handleFailure(error: unknown): void {
    if (error instanceof CloudAutoSaveConsentRequiredError) {
      this.hasCloudCopy = false;
      this.setStatus({ state: this.resolveIdleState(), savedAt: null, message: null, conflict: null, pendingAssets: 0 });
      return;
    }
    if (error instanceof CloudConflictError) {
      // Somebody else's copy is newer. Overwriting it is a decision, and this is
      // not the layer that gets to make it.
      this.paused = true;
      this.setStatus({
        state: 'paused',
        conflict: error.remote,
        message: 'This project was saved from another device. Open that copy, or replace it',
      });
      return;
    }
    if (error instanceof CloudSignInRequiredError) {
      // The transport already dropped the dead token, so the session hook is
      // about to reconfigure this anyway. Say the true thing in the meantime.
      this.setStatus({
        state: 'signed-out',
        message: 'Sign in again to keep saving this project to the cloud',
        conflict: null,
      });
      return;
    }
    if (error instanceof CloudDisabledError) {
      this.setStatus({ state: 'disabled', message: null, conflict: null });
      return;
    }

    // A refusal retrying cannot fix: the account is at its project limit, the
    // document is over the size ceiling, the row was deleted from the other
    // side. Anything that is not a request failure at all (the local row is
    // gone, the document could not be built) is in the same bucket, since no
    // amount of waiting produces a project that is not there. 408 and 429 are
    // the two 4xx that DO come good on their own.
    const hopeless =
      error instanceof CloudRequestError
        ? error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
        : true;
    if (hopeless) {
      this.paused = true;
      this.setStatus({
        state: 'paused',
        message: error instanceof Error ? error.message : 'The cloud refused that save',
        conflict: null,
      });
      return;
    }

    this.failures += 1;
    this.retryAt = Date.now() + BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    this.setStatus({
      state: 'retrying',
      message: error instanceof Error ? error.message : 'That did not reach the cloud',
      conflict: null,
    });
    console.warn('Auto save to the cloud did not land, will retry', error);
  }

  // --- status -------------------------------------------------------------

  private setStatus(patch: Partial<CloudAutoSaveStatus>): void {
    const next: CloudAutoSaveStatus = { ...this.status, ...patch };
    if (patch.state === 'paused') this.pausedStatus = { message: next.message, conflict: next.conflict };
    // One invariant, enforced in the one place every state change passes
    // through: with the feature off there is nothing to report, so a push that
    // was already in the air when it was switched off cannot land the chip back
    // on screen saying "Saved".
    if (!this.config.available || !this.config.enabled) next.state = 'disabled';
    else if (!this.config.signedIn || !this.config.accountId) next.state = 'signed-out';
    else if (!this.linkChecked || !this.hasCloudCopy) next.state = 'unlinked';
    const current = this.status;
    if (
      next.state === current.state &&
      next.savedAt === current.savedAt &&
      next.message === current.message &&
      next.conflict === current.conflict &&
      next.pendingAssets === current.pendingAssets
    ) {
      return;
    }
    this.status = next;
    this.listeners.forEach((listener) => listener());
  }
}
