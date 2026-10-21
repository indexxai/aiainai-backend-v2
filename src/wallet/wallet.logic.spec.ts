import { describe, expect, it } from 'vitest';
import { blockedBy, domainOf, isDomain, overLimit } from './wallet.logic.js';

describe('wallet rules', () => {
  it('blocks kinds of sites and exact addresses', () => {
    expect(blockedBy('https://www.meezanbank.com/login', ['banking'])).toBe('Banking sites');
    expect(blockedBy('fbr.gov.pk', ['government'])).toBe('Government sites');
    expect(blockedBy('casino-royal.com', ['gambling'])).toBe('Gambling');
    expect(blockedBy('shop.crypto-exchange.example', ['crypto-exchange.example'])).toBe(
      'crypto-exchange.example',
    );
    expect(blockedBy('skylineair.example', ['banking', 'government', 'gambling'])).toBeNull();
    expect(domainOf('HTTPS://WWW.Daraz.pk/cart')).toBe('daraz.pk');
  });

  it('checks per purchase, per day and per month', () => {
    const base = {
      currency: 'PKR',
      perPurchase: 150_000,
      perDay: 200_000,
      perMonth: 500_000,
      spentToday: 0,
      spentMonth: 0,
    };
    expect(overLimit({ ...base, amount: 98_400 })).toBeNull();
    expect(overLimit({ ...base, amount: 160_000 })).toMatch(/per purchase/);
    expect(overLimit({ ...base, amount: 120_000, spentToday: 100_000 })).toMatch(
      /per day.*100,000 spent today/,
    );
    expect(overLimit({ ...base, amount: 50_000, spentMonth: 480_000 })).toMatch(/per month/);
  });

  it('accepts real site addresses only', () => {
    for (const ok of ['example.com', 'shop.example.co.uk', 'a-b.io']) expect(isDomain(ok)).toBe(true);
    for (const bad of ['not a site !!', 'localhost', 'example', '-x.com', 'exa_mple.com', ''])
      expect(isDomain(bad)).toBe(false);
    expect(isDomain(domainOf('https://www.Example.com/path'))).toBe(true);
  });
});
