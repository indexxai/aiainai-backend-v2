/**
 * Model runs that keep going after the browser leaves (chat answers, document writing).
 * Closing the page no longer stops them; Stop is an explicit call that aborts the run by key.
 *
 * The registry lives in this process. With more than one API instance, a Stop that lands on
 * another instance falls back to marking the saved message or document as stopped.
 */
export class LiveRuns {
  private readonly runs = new Map<string, AbortController>();

  start(key: string): AbortController {
    const ac = new AbortController();
    this.runs.set(key, ac);
    return ac;
  }

  end(key: string, ac: AbortController): void {
    if (this.runs.get(key) === ac) this.runs.delete(key);
  }

  /** True when a run was found here and asked to stop. */
  stop(key: string): boolean {
    const ac = this.runs.get(key);
    if (!ac) return false;
    ac.abort(new Error('stopped by the user'));
    return true;
  }

  isLive(key: string): boolean {
    return this.runs.has(key);
  }
}

export const liveRuns = new LiveRuns();

export const runKey = {
  chat: (chatId: string) => `chat:${chatId}`,
  doc: (docId: string) => `doc:${docId}`,
};
