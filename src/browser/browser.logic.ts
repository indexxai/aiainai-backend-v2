import type { BrowserStep, BrowserView } from '../database/schemas/browser-task.schema.js';

/** Does the goal ask Jack to buy, book or order something (so it ends at a payment)? */
export const wantsPurchase = (goal: string) =>
  /\b(buy|book|order|purchase|pay for|reserve|get me)\b/i.test(goal);

/** A site named in the goal ("on daraz.pk"), if any. */
export function siteIn(goal: string): string | null {
  return (
    /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|pk|ae|net|org|co|io|shop|store|example))\b/i
      .exec(goal)?.[1]
      ?.toLowerCase() ?? null
  );
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export interface ScriptStep {
  text: string;
  view: BrowserView;
}

export interface Script {
  site: string;
  steps: ScriptStep[];
  purchase: { item: string; seller: string; amount: number } | null;
  summary: string;
}

const SAMPLES = [
  {
    match: /\b(flight|fly|ticket|airline)s?\b/i,
    site: 'skylineair.example',
    seller: 'Skyline Air',
    what: 'flights',
    choice: 'SA 615 at 08:40',
    item: (g: string) => `${/\b(two|2)\b/i.test(g) ? '2 seats' : '1 seat'}, economy · SA 615 · 08:40 → 11:10`,
    amount: 98_400,
    fields: [
      ['Passenger 1 · first name', 'Indexx'],
      ['Passenger 1 · last name', '[Last name]'],
      ['Email for the tickets', '[your email]'],
      ['Phone', '[Phone number]'],
    ],
  },
  {
    match: /\b(grocer(y|ies)|food|vegetables|milk)\b/i,
    site: 'freshcart.example',
    seller: 'FreshCart',
    what: 'groceries',
    choice: 'this week’s basket',
    item: () => 'Weekly groceries · 14 items',
    amount: 7_850,
    fields: [
      ['Delivery address', '[Your address]'],
      ['Delivery slot', 'Saturday, 10:00–12:00'],
    ],
  },
];

/**
 * Sample mode: a believable run of steps for the goal, with drawings of the pages, ending at the
 * payment (for a purchase) or at a short finding. Used when no browser service key is set.
 */
export function sampleScript(goal: string, currency: string): Script {
  const sample = SAMPLES.find((s) => s.match.test(goal));
  const site = siteIn(goal) ?? sample?.site ?? 'shop.example';
  const seller = sample?.seller ?? site.split('.')[0]!.replace(/^./, (c) => c.toUpperCase());
  const what =
    sample?.what ?? goal.replace(/^(please\s+)?(find|buy|book|order|get me)\s+(me\s+)?/i, '').slice(0, 60);
  const purchase = wantsPurchase(goal);
  const amount = sample?.amount ?? 2_000 + (hash(goal) % 60) * 500;
  const url = (path: string) => `${site}/${path}`;
  const steps: ScriptStep[] = [
    {
      text: `Opened ${site}`,
      view: { url: url(''), site: seller, heading: `Welcome to ${seller}`, fields: [] },
    },
    {
      text: `Searched for ${what}`,
      view: {
        url: url('search'),
        site: seller,
        heading: `Results for “${what}”`,
        fields: [],
        note: '6 results',
      },
    },
    {
      text: 'Compared 6 options',
      view: {
        url: url('search?sort=best'),
        site: seller,
        heading: 'Best matches first',
        fields: [],
        note: 'Sorted by price and time',
      },
    },
    {
      text: `Chose ${sample?.choice ?? 'the best match'} · ${currency} ${amount.toLocaleString('en-US')}`,
      view: {
        url: url('item'),
        site: seller,
        heading: sample?.item(goal) ?? what,
        fields: [],
        button: purchase ? 'Continue' : undefined,
      },
    },
  ];
  if (purchase)
    steps.push({
      text: 'Filled in your details',
      view: {
        url: url('checkout/details'),
        site: seller,
        heading: 'Your details',
        fields: (
          sample?.fields ?? [
            ['Name', 'Indexx'],
            ['Delivery address', '[Your address]'],
          ]
        ).map(([label, value], i, all) => ({
          label: label!,
          value: value!,
          active: i === all.length - 1,
        })),
        button: 'Continue to payment',
      },
    });
  return {
    site,
    steps,
    purchase: purchase ? { item: sample?.item(goal) ?? what, seller, amount } : null,
    summary: purchase
      ? `Ready to pay ${currency} ${amount.toLocaleString('en-US')} to ${seller}`
      : [
          `Found 6 options on ${site} (sample results). The best three:`,
          '',
          `1. **${sample?.choice ?? 'The first match'}** · ${currency} ${amount.toLocaleString('en-US')} · best value`,
          `2. **The second match** · ${currency} ${Math.round(amount * 1.15).toLocaleString('en-US')} · better reviews`,
          `3. **The third match** · ${currency} ${Math.round(amount * 1.3).toLocaleString('en-US')} · most choice`,
        ].join('\n'),
  };
}

export const step = (text: string, state: BrowserStep['state']): BrowserStep => ({
  at: new Date(),
  text,
  state,
});
