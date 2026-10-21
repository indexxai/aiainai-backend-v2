import { Logger } from '@nestjs/common';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { runAgent } from './agent-loop.js';
import type { BrowserDriver, DriverHooks, RunOptions } from './driver.js';

const API = 'https://api.browserbase.com/v1';
/** The hosted browser's window: a common laptop size, shown in a 16:10 frame. */
export const VIEWPORT = { width: 1280, height: 800 };

/** Browserbase's live view without its own navigation bar (the app shows the address). */
export function liveViewUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set('navbar', 'false');
  return u.toString();
}

/**
 * Dark or light sites in the hosted browser. Sites with their own dark mode use it
 * (prefers-color-scheme); Chrome's automatic dark mode darkens the rest.
 */
export class SchemeSync {
  private current: 'light' | 'dark' | null = null;
  // Kept open: Chrome drops a session's emulation settings when it detaches.
  private cdp: CDPSession | null = null;
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async apply(scheme: 'light' | 'dark') {
    if (scheme === this.current) return;
    this.current = scheme;
    await this.page.emulateMedia({ colorScheme: scheme });
    this.cdp ??= await this.context.newCDPSession(this.page);
    await this.cdp.send('Emulation.setAutoDarkModeOverride', { enabled: scheme === 'dark' });
  }
}

/** A task's browser closes by itself after this long (30 minutes). */
const SESSION_SECONDS = 30 * 60;

/**
 * Browserbase (browserbase.com): a private, hosted Chrome per task with a live view the person
 * can watch and take over. Jack drives it over the DevTools protocol with his own loop
 * (agent-loop.ts). Check the session fields on the first run with a live key.
 */
export class BrowserbaseDriver implements BrowserDriver {
  readonly live = true;
  readonly available = true;
  private readonly logger = new Logger(BrowserbaseDriver.name);
  private readonly connectUrls = new Map<string, string>();

  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'X-BB-API-Key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as T;
    if (!res.ok) {
      this.logger.warn({ status: res.status, path }, 'Browserbase call failed');
      throw new Error(`Browserbase ${method} ${path} failed (${res.status})`);
    }
    return json;
  }

  async open() {
    const s = await this.call<{ id: string; connectUrl: string }>('POST', '/sessions', {
      projectId: this.projectId,
      keepAlive: true,
      // Ends on its own even if nobody comes back (a payment or a security check left waiting).
      timeout: SESSION_SECONDS,
      // A desktop window close to the size it's shown at, so the live view stays sharp.
      browserSettings: { viewport: VIEWPORT },
    });
    this.connectUrls.set(s.id, s.connectUrl);
    const debug = await this.call<{ debuggerFullscreenUrl?: string }>('GET', `/sessions/${s.id}/debug`);
    return {
      ref: s.id,
      liveUrl: debug.debuggerFullscreenUrl ? liveViewUrl(debug.debuggerFullscreenUrl) : null,
    };
  }

  async run(ref: string, goal: string, hooks: DriverHooks, opts: RunOptions): Promise<void> {
    const url = this.connectUrls.get(ref);
    if (!url || !opts.decide) return hooks.fail('The browser session ended. Start the task again.');
    const browser = await chromium.connectOverCDP(url);
    try {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      // Browserbase solves CAPTCHAs itself and says so in the page console; Jack waits meanwhile.
      let solving = false;
      context.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('browserbase-solving-started')) solving = true;
        else if (t.includes('browserbase-solving-finished')) solving = false;
      });
      // Sites dark or light to match the person's app theme, checked while Jack works.
      const theme = new SchemeSync(context, page);
      const sync = setInterval(
        () =>
          void hooks
            .scheme()
            .then((s) => theme.apply(s))
            .catch(() => undefined),
        1500,
      );
      await theme.apply(await hooks.scheme()).catch(() => undefined);
      try {
        await runAgent(page, goal, hooks, opts.decide, opts.maxSteps, {
          search: opts.search,
          solving: () => solving,
        });
      } finally {
        clearInterval(sync);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async close(ref: string): Promise<void> {
    this.connectUrls.delete(ref);
    await this.call('POST', `/sessions/${ref}`, {
      projectId: this.projectId,
      status: 'REQUEST_RELEASE',
    }).catch((err: unknown) => this.logger.warn({ err, ref }, 'Releasing a browser session failed'));
  }
}
