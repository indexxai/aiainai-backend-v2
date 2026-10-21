import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observe, runAgent } from './agent-loop.js';
import type { Decision, DriverHooks } from './driver.js';
import { liveViewUrl, SchemeSync } from './browserbase-driver.js';

const SHOP = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Skyline Shop</h1>
<label>Search <input id="q" name="q"></label>
<button onclick="document.getElementById('r').hidden=false">Search</button>
<div id="r" hidden><p>Phone case — PKR 2,400</p><button onclick="location.hash='checkout';document.body.innerHTML='<h1>Payment</h1><label>Card number <input autocomplete=cc-number></label><button>Pay PKR 2,400</button>'">Buy now</button></div>
</body></html>`;

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Needs a local Chromium (present in the dev container and CI image); skipped elsewhere.
describe.skipIf(!existsSync(executablePath))(
  'Jack’s browsing loop (local browser, scripted decisions)',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ executablePath });
    });
    afterAll(async () => browser?.close());

    function hooks() {
      const log: string[] = [];
      let purchase: unknown = null;
      let ended = '';
      const asked: string[] = [];
      const ctl = { state: 'go' as 'go' | 'wait' | 'stop' };
      const h: DriverHooks = {
        step: async (t) => void log.push(t),
        purchaseReady: async (p) => void (purchase = p),
        done: async (s) => void (ended = `done: ${s}`),
        fail: async (r) => void (ended = `fail: ${r}`),
        state: async () => ctl.state,
        blocked: async (url) => (/casino/.test(url) ? 'Gambling' : null),
        scheme: async () => 'light',
        needsYou: async (r) => {
          asked.push(r);
          ctl.state = 'wait';
        },
      };
      return {
        h,
        log,
        asked,
        ctl,
        get purchase() {
          return purchase;
        },
        get ended() {
          return ended;
        },
      };
    }

    const d = (x: Partial<Decision>): Decision => ({
      action: 'click',
      target: -1,
      value: '',
      note: '',
      item: '',
      seller: '',
      amount: 0,
      ...x,
    });

    it('searches, picks, and stops at the payment page for the person’s OK', async () => {
      const page = await browser.newPage();
      await page.setContent(SHOP);
      const label = (o: Awaited<ReturnType<typeof observe>>, text: string) =>
        o.elements.find((e) => e.label.includes(text))!.id;
      const script = [
        (o: Awaited<ReturnType<typeof observe>>) =>
          d({ action: 'fill', target: label(o, 'Search'), value: 'phone case', note: 'Typing the search' }),
        (o: Awaited<ReturnType<typeof observe>>) =>
          d({
            action: 'click',
            target: o.elements.find((e) => e.tag === 'button' && e.label === 'Search')!.id,
            note: 'Searching',
          }),
        (o: Awaited<ReturnType<typeof observe>>) =>
          d({ action: 'click', target: label(o, 'Buy now'), note: 'Choosing the phone case' }),
        (o: Awaited<ReturnType<typeof observe>>) => {
          expect(o.text).toContain('Payment');
          return d({ action: 'checkout', item: 'Phone case', seller: 'Skyline Shop', amount: 2400 });
        },
      ];
      let i = 0;
      const t = hooks();
      await runAgent(page, 'buy a phone case', t.h, async (o) => script[i++]!(o));
      expect(t.log).toEqual(['Typing the search', 'Searching', 'Choosing the phone case']);
      expect(t.purchase).toMatchObject({ item: 'Phone case', amount: 2400 });
      await page.close();
    });

    it('never types into card fields and won’t open blocked sites', async () => {
      const page = await browser.newPage();
      await page.setContent('<label>Card number <input autocomplete="cc-number"></label>');
      const t = hooks();
      await runAgent(page, 'pay', t.h, async (o) =>
        d({ action: 'fill', target: o.elements[0]!.id, value: '4242 4242' }),
      );
      expect(t.ended).toMatch(/^fail: Stopped before a password or card field/);
      const t2 = hooks();
      await runAgent(page, 'play', t2.h, async () => d({ action: 'goto', value: 'casino-royal.com' }));
      expect(t2.ended).toMatch(/blocked in your Wallet \(Gambling\)/);
      await page.close();
    });

    const found = [
      { title: 'Nishat Hotel high tea', url: 'https://nishat.example/high-tea', snippet: 'Buffet' },
    ];

    it('searches with the search tool instead of opening a search engine page', async () => {
      const page = await browser.newPage();
      await page.setContent('<p>Start</p>');
      const searched: string[] = [];
      const t = hooks();
      let i = 0;
      await runAgent(
        page,
        'best high tea in Lahore',
        t.h,
        async (o) =>
          i++ === 0
            ? d({ action: 'goto', value: 'https://www.google.com/search?q=high+tea+in+lahore' })
            : d({ action: 'done', value: `Found ${o.results?.[0]?.title}` }),
        25,
        { search: async (q) => (searched.push(q), found) },
      );
      expect(searched).toEqual(['high tea in lahore']);
      expect(t.log).toEqual(['Searched the web for “high tea in lahore”']);
      expect(t.ended).toBe('done: Found Nishat Hotel high tea');
      expect(page.url()).not.toContain('google');
      await page.close();
    });

    it('on a search engine’s security check, searches with the tool instead of waiting', async () => {
      const page = await browser.newPage();
      await page.route('https://www.google.com/**', (r) =>
        r.fulfill({
          contentType: 'text/html',
          body: '<title>Sorry</title><p>Our systems have detected unusual traffic from your computer network.</p>',
        }),
      );
      await page.goto(
        'https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dhigh%2Btea&q=EhAgAbc',
      );
      const searched: string[] = [];
      const t = hooks();
      await runAgent(
        page,
        'high tea',
        t.h,
        async (o) => d({ action: 'done', value: `${o.results?.length} results` }),
        25,
        {
          search: async (q) => (searched.push(q), found),
        },
      );
      expect(searched).toEqual(['high tea']);
      expect(t.asked).toEqual([]);
      expect(t.ended).toBe('done: 1 results');
      await page.close();
    });

    it('waits while the browser service solves a security check, then carries on', async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Shop</h1><div class="g-recaptcha"></div>');
      let solving = true;
      setTimeout(() => {
        void page.setContent('<h1>Shop</h1><p>Welcome back</p>');
        solving = false;
      }, 600);
      const t = hooks();
      await runAgent(page, 'shop', t.h, async (o) => d({ action: 'done', value: o.text.slice(0, 20) }), 25, {
        solving: () => solving,
        checkWaitMs: 5000,
      });
      expect(t.log).toEqual(['Waiting for a security check on the page…', 'The security check is done']);
      expect(t.asked).toEqual([]);
      expect(t.ended).toBe('done: Shop Welcome back');
      await page.close();
    });

    it('asks the person to take over when a security check isn’t solved, and carries on after', async () => {
      const page = await browser.newPage();
      await page.setContent('<p>Please verify you are human</p><div class="cf-turnstile"></div>');
      const t = hooks();
      const run = runAgent(page, 'shop', t.h, async () => d({ action: 'done', value: 'Read the page' }), 25, {
        checkWaitMs: 300,
      });
      // The person takes over, solves it and hands the browser back.
      for (let n = 0; n < 50 && !t.asked.length; n++) await new Promise((r) => setTimeout(r, 50));
      expect(t.asked[0]).toMatch(/security check\. Take over to solve it/);
      await page.setContent('<p>Thanks, you can continue</p>');
      t.ctl.state = 'go';
      await run;
      expect(t.ended).toBe('done: Read the page');
      await page.close();
    });

    it('shows sites dark or light to match the app theme', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent('<p>Site</p>');
      const dark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
      const sync = new SchemeSync(context, page);
      await sync.apply('dark');
      expect(await dark()).toBe(true);
      await page.setContent('<p>Next page</p>');
      expect(await dark()).toBe(true);
      await sync.apply('light');
      expect(await dark()).toBe(false);
      await context.close();
    });

    it('reports the page address with each step (for the address bar over the live view)', async () => {
      const page = await browser.newPage();
      await page.route('https://nishat.example/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: '<title>Nishat high tea</title><p>Buffet</p>' }),
      );
      const views: unknown[] = [];
      const t = hooks();
      t.h.step = async (_text, view) => void views.push(view);
      let i = 0;
      await runAgent(page, 'high tea', t.h, async () =>
        i++ === 0
          ? d({ action: 'goto', value: 'https://nishat.example/high-tea', note: 'Opening Nishat' })
          : d({ action: 'done' }),
      );
      expect(views[0]).toEqual({
        url: 'https://nishat.example/high-tea',
        site: 'nishat.example',
        heading: 'Nishat high tea',
        fields: [],
      });
      await page.close();
    });
  },
);

describe('live view link', () => {
  it('hides Browserbase’s own navigation bar', () => {
    expect(
      liveViewUrl(
        'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.example/debug/abc',
      ),
    ).toBe(
      'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.example%2Fdebug%2Fabc&navbar=false',
    );
  });
});
