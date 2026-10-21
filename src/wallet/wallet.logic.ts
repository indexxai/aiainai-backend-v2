/** Kinds of sites that can be blocked in one go, with how to recognise them by address. */
export const SITE_KINDS: Record<string, { label: string; match: RegExp }> = {
  banking: { label: 'Banking sites', match: /(^|\.)(bank|banking)|bank\./i },
  government: { label: 'Government sites', match: /\.gov(\.|$)|(^|\.)gov\./i },
  gambling: { label: 'Gambling', match: /casino|poker|betting|(^|\.)bet[a-z0-9-]*\.|lottery/i },
  crypto: { label: 'Crypto exchanges', match: /binance|coinbase|kraken|bybit|exchange/i },
};

export function domainOf(site: string): string {
  const s = site.trim().toLowerCase();
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return s.replace(/^www\./, '');
  }
}

/** A plain domain name such as example.com or shop.example.co.uk. */
export function isDomain(host: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
}

/** Is this site blocked? Entries are a kind ("banking") or an address ("example.com"). */
export function blockedBy(site: string, blocked: readonly string[]): string | null {
  const host = domainOf(site);
  if (!host) return null;
  for (const entry of blocked) {
    const kind = SITE_KINDS[entry];
    if (kind) {
      if (kind.match.test(host)) return kind.label;
      continue;
    }
    const d = domainOf(entry);
    if (d && (host === d || host.endsWith(`.${d}`))) return d;
  }
  return null;
}

/** Why a purchase can't be approved under the limits, or null when it fits. */
export function overLimit(input: {
  amount: number;
  currency: string;
  perPurchase: number;
  perDay: number;
  perMonth: number;
  spentToday: number;
  spentMonth: number;
}): string | null {
  const money = (n: number) => `${input.currency} ${n.toLocaleString('en-US')}`;
  if (input.amount > input.perPurchase)
    return `This is more than your limit of ${money(input.perPurchase)} per purchase. Raise it in Wallet to approve.`;
  if (input.spentToday + input.amount > input.perDay)
    return `This would go over your limit of ${money(input.perDay)} per day (${money(input.spentToday)} spent today).`;
  if (input.spentMonth + input.amount > input.perMonth)
    return `This would go over your limit of ${money(input.perMonth)} per month (${money(input.spentMonth)} spent this month).`;
  return null;
}

export function startOfDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function startOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
