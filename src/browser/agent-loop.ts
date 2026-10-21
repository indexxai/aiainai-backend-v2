import type { Page } from 'playwright-core';
import type { Decision, DriverHooks, Observation, SearchResult } from './driver.js';

const TEXT_CHARS = 4000;
const MAX_ELEMENTS = 60;

/** Number the things on the page Jack can use, and read what it says. */
export async function observe(page: Page, goal: string, history: string[]): Promise<Observation> {
  const { text, elements, challenge } = await page.evaluate(
    ({ maxEls, maxText }) => {
      const els = Array.from(
        document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [role="button"]'),
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const list = els.slice(0, maxEls).map((el, i) => {
        el.setAttribute('data-jack-id', String(i));
        const input = el as HTMLInputElement;
        const label =
          el.getAttribute('aria-label') ||
          (input.labels && input.labels[0]?.textContent) ||
          input.placeholder ||
          el.textContent ||
          input.name ||
          '';
        return {
          id: i,
          tag: el.tagName.toLowerCase(),
          label: label.replace(/\s+/g, ' ').trim().slice(0, 80),
          type: input.type || undefined,
          value: el.tagName === 'INPUT' && input.type !== 'password' ? input.value.slice(0, 80) : undefined,
        };
      });
      const challenge = !!document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], #captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile',
      );
      return {
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, maxText),
        elements: list,
        challenge,
      };
    },
    { maxEls: MAX_ELEMENTS, maxText: TEXT_CHARS },
  );
  const url = page.url();
  const title = await page.title();
  return {
    goal,
    url,
    title,
    text,
    elements,
    history: history.slice(-12),
    captcha: challenge || looksLikeCheck(url, title, text),
  };
}

/** Pages that are a security check rather than the site ("unusual traffic", "verify you are human"). */
export function looksLikeCheck(url: string, title: string, text: string): boolean {
  if (/google\.[a-z.]+\/sorry\//i.test(url)) return true;
  const words = `${title} ${text.slice(0, 600)}`;
  return /unusual traffic|verify (that )?you are (a )?human|are you a robot|i'?m not a robot|complete the security check|checking your browser|press (and|&) hold/i.test(
    words,
  );
}

/** A search engine's results page (Google, Bing, DuckDuckGo…): Jack uses the search tool instead. */
export function searchQueryIn(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    const engine =
      /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z]+)$/i.test(
        u.hostname,
      );
    if (!engine) return null;
    // Google's "unusual traffic" page: the search is in the link it would continue to.
    if (u.pathname.startsWith('/sorry')) {
      const next = u.searchParams.get('continue');
      return next ? searchQueryIn(next) : '';
    }
    const q = u.searchParams.get('q') ?? u.searchParams.get('p') ?? u.searchParams.get('text');
    return q?.trim() || (u.pathname === '/' || u.pathname === '' ? '' : null);
  } catch {
    return null;
  }
}

/** How long Jack gives the browser service to solve a security check before asking the person. */
export const CHECK_WAIT_MS = 40_000;

/**
 * Jack's browsing loop: look at the page, decide one action, do it, repeat. Never types into
 * password or card fields and never presses a final pay button: at the payment page he stops
 * (`checkout`) and the person decides.
 *
 * Search engines block automated browsers with CAPTCHAs, so with a search tool Jack searches
 * through it and opens the sites directly. When a page still shows a security check, he waits for
 * the browser service to solve it (`checks.solving`), then asks the person to take over.
 */
export async function runAgent(
  page: Page,
  goal: string,
  hooks: DriverHooks,
  decide: (o: Observation) => Promise<Decision>,
  maxSteps = 25,
  opts: {
    search?: (query: string) => Promise<SearchResult[]>;
    /** True while the browser service is solving a security check on its own. */
    solving?: () => boolean;
    /** How long to wait for a check to clear before asking the person (tests use less). */
    checkWaitMs?: number;
  } = {},
): Promise<void> {
  const history: string[] = [];
  const waitMs = opts.checkWaitMs ?? CHECK_WAIT_MS;
  let results: SearchResult[] | undefined;

  const doSearch = async (query: string) => {
    results = await opts.search!(query);
    const note = `Searched the web for “${query.slice(0, 80)}”`;
    history.push(note);
    await hooks.step(results.length ? note : `${note}: nothing found`);
  };

  for (let i = 0; i < maxSteps; i++) {
    if (!(await waitWhilePaused(hooks))) return;
    let o = await observe(page, goal, history);

    if (o.captcha) {
      // A search engine's check: skip it and search with the tool instead.
      const q = opts.search ? searchQueryIn(o.url) : null;
      if (q) {
        await doSearch(q);
        await page.goto('about:blank').catch(() => undefined);
        continue;
      }
      // Give the browser service time to solve it.
      await hooks.step('Waiting for a security check on the page…');
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(opts.solving?.() ? 2000 : 1000);
        o = await observe(page, goal, history);
        if (!o.captcha && !opts.solving?.()) break;
      }
      if (o.captcha) {
        // Still there: the person solves it (Take over), and Jack carries on after.
        await hooks.needsYou(
          'This site wants a security check. Take over to solve it, then hand the browser back.',
        );
        if (!(await waitWhilePaused(hooks))) return;
        continue;
      }
      await hooks.step('The security check is done');
    }

    const d = await decide({ ...o, results });

    // Opening a search engine's results page: use the search tool instead (no CAPTCHA).
    if (d.action === 'goto' && opts.search) {
      const q = searchQueryIn(d.value);
      if (q) {
        await doSearch(q);
        continue;
      }
    }
    if (d.action === 'search') {
      if (!opts.search) return hooks.fail('Web search isn’t set up here. Ask again with the site to open.');
      await doSearch(d.value || goal);
      continue;
    }

    const target = page.locator(`[data-jack-id="${d.target}"]`);
    if (d.action === 'checkout') {
      return hooks.purchaseReady({
        item: d.item || goal,
        seller: d.seller || new URL(page.url()).hostname,
        amount: Math.max(0, Math.round(d.amount)),
        site: new URL(page.url()).hostname,
      });
    }
    if (d.action === 'done') return hooks.done(d.value || d.note || 'Finished');
    if (d.action === 'goto') {
      const blocked = await hooks.blocked(d.value);
      if (blocked) return hooks.fail(`${d.value} is blocked in your Wallet (${blocked}).`);
      await page.goto(d.value.includes('://') ? d.value : `https://${d.value}`, {
        waitUntil: 'domcontentloaded',
      });
    } else if (d.action === 'fill') {
      const kind = (await target.getAttribute('type')) ?? '';
      const auto = (await target.getAttribute('autocomplete')) ?? '';
      if (/password/i.test(kind) || /cc-|card/i.test(auto)) {
        return hooks.fail('Stopped before a password or card field. Use Take over to fill it in yourself.');
      }
      await target.fill(d.value);
    } else {
      await target.click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    history.push(d.note);
    await hooks.step(d.note || `${d.action} ${d.value}`.trim(), await addressOf(page));
  }
  await hooks.fail('This took more steps than allowed. Try a narrower request.');
}

/** The page's address and title, for the app's address bar over the live view. */
async function addressOf(page: Page) {
  const url = page.url();
  let site = '';
  try {
    site = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* about:blank */
  }
  return { url, site, heading: await page.title().catch(() => ''), fields: [] };
}

/** Wait while the person has paused or taken over. False when the task was stopped. */
async function waitWhilePaused(hooks: DriverHooks): Promise<boolean> {
  for (;;) {
    const s = await hooks.state();
    if (s === 'stop') return false;
    if (s === 'go') return true;
    await sleep(1000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
