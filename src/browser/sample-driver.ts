import { sampleScript } from './browser.logic.js';
import type { BrowserDriver, DriverHooks, RunOptions } from './driver.js';

/**
 * Sample mode (no browser service key): plays a believable run of steps with drawings of the
 * pages, at a human pace, and stops at the payment exactly like the real browser.
 */
export class SampleDriver implements BrowserDriver {
  readonly live = false;

  constructor(
    private readonly stepMs = 1500,
    readonly available = true,
  ) {}

  async open() {
    return { ref: `sample-${Date.now().toString(36)}`, liveUrl: null };
  }

  async run(_ref: string, goal: string, hooks: DriverHooks, opts: RunOptions): Promise<void> {
    const script = sampleScript(goal, opts.currency);
    const blocked = await hooks.blocked(script.site);
    if (blocked) return hooks.fail(`${script.site} is blocked in your Wallet (${blocked}).`);
    // CHECK_DEMO in the request: a security check after the first page, to try Take over.
    let check = /\bCHECK_DEMO\b/.test(goal);
    for (const s of script.steps) {
      if (!(await this.wait(hooks))) return;
      await hooks.step(s.text, s.view);
      if (check) {
        check = false;
        await hooks.needsYou(
          'This site wants a security check. Take over to solve it, then hand the browser back.',
        );
      }
    }
    if (!(await this.wait(hooks))) return;
    if (script.purchase) await hooks.purchaseReady({ ...script.purchase, site: script.site });
    else await hooks.done(script.summary);
  }

  /** Pause between steps; hold while paused or taken over. False when stopped. */
  private async wait(hooks: DriverHooks): Promise<boolean> {
    await new Promise((r) => setTimeout(r, this.stepMs));
    for (;;) {
      const s = await hooks.state();
      if (s === 'stop') return false;
      if (s === 'go') return true;
      await new Promise((r) => setTimeout(r, Math.min(this.stepMs, 1000)));
    }
  }

  async close(): Promise<void> {}
}
