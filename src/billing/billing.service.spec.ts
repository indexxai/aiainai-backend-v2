import { Types, type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CreditEntrySchema, type CreditEntry } from '../credits/credit.schema.js';
import type { CreditsService } from '../credits/credits.service.js';
import { UsageEventSchema, type UsageEvent } from '../database/schemas/usage-event.schema.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { MemoryModel } from '../testing/memory-model.js';
import { BillingService } from './billing.service.js';

async function setup() {
  const usage = new MemoryModel('UsageEvent', UsageEventSchema);
  const ledger = new MemoryModel('CreditEntry', CreditEntrySchema);
  const credits = new FakeCredits(0, ledger);
  const svc = new BillingService(
    credits as unknown as CreditsService,
    modelsService(seedRows(), {}),
    usage as unknown as Model<UsageEvent>,
    ledger as unknown as Model<CreditEntry>,
  );
  const ws = {
    _id: new Types.ObjectId(),
    plan: 'free' as const,
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 29 * 86_400_000),
  };
  await credits.grant({ workspaceId: ws._id, amount: 100, key: 'g', reason: 'Jack Free monthly credits' });
  await new Promise((r) => setTimeout(r, 2));
  const use = (tool: string, credits: number, outcome = 'ok', at = new Date()) =>
    usage.create({
      workspaceId: ws._id,
      userId: 'u',
      tool,
      modelKey: 'claude-sonnet',
      provider: 'Anthropic',
      credits,
      outcome,
      createdAt: at,
    });
  return { svc, ws, use };
}

describe('BillingService', () => {
  it('sums credits by tool for this period only', async () => {
    const { svc, ws, use } = await setup();
    await use('chat', 2);
    await use('chat', 1, 'stopped');
    await use('docs', 6);
    await use('chat', 0, 'failed');
    await use('chat', 50, 'ok', new Date(Date.now() - 40 * 86_400_000)); // last period
    const s = await svc.summary(ws);
    expect(s.byTool).toEqual([
      { tool: 'docs', label: 'AI Docs', credits: 6 },
      { tool: 'chat', label: 'AI Chat', credits: 3 },
    ]);
    expect(s.usedThisPeriod).toBe(9);
    expect(s.plan).toMatchObject({ key: 'free', label: 'Jack Free', monthlyCredits: 100 });
    expect(s.storage.limitBytes).toBeGreaterThan(0);
  });

  it('lists usage and credits added, newest first, with plain statuses', async () => {
    const { svc, ws, use } = await setup();
    await use('chat', 2, 'ok', new Date(Date.now() + 1000));
    await use('docs', 0, 'failed', new Date(Date.now() + 2000));
    const h = await svc.history(ws);
    expect(h.items.map((i) => [i.activity, i.status, i.credits])).toEqual([
      ['AI Docs · Claude Sonnet', 'failed', 0],
      ['AI Chat · Claude Sonnet', 'charged', -2],
      ['Jack Free monthly credits', 'added', 100],
    ]);
    expect(h.nextCursor).toBeNull();
  });
});
