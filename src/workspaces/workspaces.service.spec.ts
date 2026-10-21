import { Logger } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import type { UserProfile } from '../database/schemas/user-profile.schema.js';
import {
  WorkspaceSchema,
  type Workspace,
  type WorkspaceDocument,
} from '../database/schemas/workspace.schema.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { MemoryModel } from '../testing/memory-model.js';
import { WorkspacesService } from './workspaces.service.js';

Logger.overrideLogger(false);

async function setup(periodStart: string, periodEnd: string) {
  const workspaces = new MemoryModel('Workspace', WorkspaceSchema);
  const credits = new FakeCredits(0);
  const svc = new WorkspacesService(
    {} as Connection,
    workspaces as unknown as Model<Workspace>,
    {} as Model<UserProfile>,
    credits as unknown as CreditsService,
  );
  const ws = (await workspaces.create({
    name: 'W',
    ownerUserId: 'u1',
    plan: 'free',
    periodStart: new Date(periodStart),
    periodEnd: new Date(periodEnd),
    createdAt: new Date(periodStart),
  })) as WorkspaceDocument;
  await credits.grant({ workspaceId: ws._id, amount: 100, key: `plan:first` });
  return { svc, ws, credits };
}

describe('monthly plan credits', () => {
  it('does nothing during the period', async () => {
    const { svc, ws, credits } = await setup('2026-10-05T09:00:00Z', '2026-11-05T09:00:00Z');
    const out = await svc.renewIfDue(ws, new Date('2026-10-20T00:00:00Z'));
    expect(out.periodEnd.toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(credits.entries).toHaveLength(1);
  });

  it('expires unused plan credits and grants the new month once', async () => {
    const { svc, ws, credits } = await setup('2026-10-05T09:00:00Z', '2026-11-05T09:00:00Z');
    await credits.hold({ workspaceId: ws._id, amount: 30 });
    const now = new Date('2026-11-06T00:00:00Z');
    const out = await svc.renewIfDue(ws, now);
    expect([out.periodStart.toISOString(), out.periodEnd.toISOString()]).toEqual([
      '2026-11-05T09:00:00.000Z',
      '2026-12-05T09:00:00.000Z',
    ]);
    expect(credits.entries.map((e) => [e.type, e.amount])).toEqual([
      ['grant', 100],
      ['expire', -70],
      ['grant', 100],
    ]);
    // a second request with the old copy of the workspace changes nothing
    await svc.renewIfDue(ws, now);
    expect(credits.entries).toHaveLength(3);
    expect((await credits.balance(ws._id)).spendable).toBe(100);
  });

  it('skips months nobody used and lands on the current period', async () => {
    const { svc, ws, credits } = await setup('2026-01-31T10:00:00Z', '2026-02-28T10:00:00Z');
    const out = await svc.renewIfDue(ws, new Date('2026-07-04T00:00:00Z'));
    expect([out.periodStart.toISOString().slice(0, 10), out.periodEnd.toISOString().slice(0, 10)]).toEqual([
      '2026-06-30',
      '2026-07-31',
    ]);
    expect(credits.entries.filter((e) => e.type === 'grant')).toHaveLength(2);
  });
});
