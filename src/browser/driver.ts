import type { BrowserView } from '../database/schemas/browser-task.schema.js';

/** What the driver reports back while working. */
export interface DriverHooks {
  step(text: string, view?: BrowserView): Promise<void>;
  /** Reached the payment page: stop there and ask the person. */
  purchaseReady(p: { item: string; seller: string; amount: number; site: string }): Promise<void>;
  done(summary: string): Promise<void>;
  fail(reason: string): Promise<void>;
  /** Paused or taken over by the person (wait), or stopped (end). */
  state(): Promise<'go' | 'wait' | 'stop'>;
  /** Is this address blocked in the Wallet? Returns the reason. */
  blocked(url: string): Promise<string | null>;
  /**
   * Something only the person can do (a security check that wasn't solved): the task pauses with
   * this message, the browser stays open, and Jack carries on once they hand it back.
   */
  needsYou(reason: string): Promise<void>;
  /** Light or dark, to match the person's app theme while they watch. */
  scheme(): Promise<'light' | 'dark'>;
}

/** A web search result (from the search tool, not a search engine page). */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** What Jack sees on the page, for deciding the next action. */
export interface Observation {
  goal: string;
  url: string;
  title: string;
  text: string;
  /** Things he can click or type into, numbered. */
  elements: { id: number; tag: string; label: string; type?: string; value?: string }[];
  history: string[];
  /** The page shows a security check (CAPTCHA, "unusual traffic", "verify you are human"). */
  captcha: boolean;
  /** The latest web search results, when Jack searched. */
  results?: SearchResult[];
}

export interface Decision {
  action: 'goto' | 'click' | 'fill' | 'search' | 'done' | 'checkout';
  /** Element number for click / fill. */
  target: number;
  /** URL for goto, text for fill, words for search, the finding for done. */
  value: string;
  /** What Jack is doing, in a few words ("Searching for flights"). */
  note: string;
  /** checkout: what is being bought, from whom, and the total (whole currency units). */
  item: string;
  seller: string;
  amount: number;
}

export interface RunOptions {
  currency: string;
  /** The model call that picks the next action (live browser only). */
  decide?: (o: Observation) => Promise<Decision>;
  /** Web search without a search engine page (so no CAPTCHA). Absent when not set up. */
  search?: (query: string) => Promise<SearchResult[]>;
  maxSteps?: number;
}

/** A private browser session per task: the hosted browser service, or sample mode. */
export interface BrowserDriver {
  readonly live: boolean;
  /** Can Jack use a browser at all here (off in production without a browser service key). */
  readonly available: boolean;
  open(): Promise<{ ref: string; liveUrl: string | null }>;
  run(ref: string, goal: string, hooks: DriverHooks, opts: RunOptions): Promise<void>;
  close(ref: string): Promise<void>;
}

export const BROWSER_DRIVER = Symbol('BrowserDriver');
