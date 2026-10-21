import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { CreditsModule } from '../src/credits/credits.module.js';
import { CreditsService } from '../src/credits/credits.service.js';

const uri = process.env.MONGODB_TEST_URI;
const describeDb = uri ? describe : describe.skip;

describeDb('CreditsService (real MongoDB)', () => {
  let credits: CreditsService;
  let conn: Connection;
  let close: () => Promise<void>;
  const dbName = `aiainai_test_${Date.now()}`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri!, { dbName }), CreditsModule],
    }).compile();
    const app = await mod.init();
    credits = app.get(CreditsService);
    conn = app.get<Connection>(getConnectionToken());
    for (const m of Object.values(conn.models)) await m.syncIndexes();
    close = async () => {
      await conn.dropDatabase();
      await app.close();
    };
  });

  afterAll(async () => close?.());

  const newWs = () => new Types.ObjectId();

  it('grants, holds, charges the actual cost and returns the rest', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 10, key: 'g1', reason: 'test' });
    await credits.grant({ workspaceId: ws, bucket: 'topup', amount: 5, key: 't1', reason: 'test' });

    const hold = await credits.hold({ workspaceId: ws, amount: 12, key: 'h1', reason: 'chat answer' });
    expect(hold.allocation).toEqual([
      { bucket: 'plan', amount: 10 },
      { bucket: 'topup', amount: 2 },
    ]);
    expect(await credits.balance(ws)).toMatchObject({ plan: 0, topup: 3, held: 12, spendable: 3 });

    const res = await credits.settle({
      workspaceId: ws,
      holdId: hold.holdId,
      actual: 7,
      reason: 'chat answer',
    });
    expect(res).toMatchObject({ charged: 7, released: 5 });
    expect(await credits.balance(ws)).toMatchObject({ plan: 3, topup: 5, held: 0, spendable: 8 });
  });

  it('never charges twice for the same key', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 10, key: 'g', reason: 'test' });
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 10, key: 'g', reason: 'test (retried)' });
    const a = await credits.hold({ workspaceId: ws, amount: 4, key: 'same', reason: 'x' });
    const b = await credits.hold({ workspaceId: ws, amount: 4, key: 'same', reason: 'x (retried)' });
    expect(b.holdId).toBe(a.holdId);
    await credits.settle({ workspaceId: ws, holdId: a.holdId, actual: 4, reason: 'x' });
    await credits.settle({ workspaceId: ws, holdId: a.holdId, actual: 4, reason: 'x (retried)' });
    expect(await credits.balance(ws)).toMatchObject({ plan: 6, held: 0 });
  });

  it('refuses to overspend, even with simultaneous requests', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 5, key: 'g', reason: 'test' });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        credits.hold({ workspaceId: ws, amount: 2, key: `h${i}`, reason: 'race' }),
      ),
    );
    const ok = attempts.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    const failed = attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('insufficient_credits');
    expect(await credits.balance(ws)).toMatchObject({ plan: 1, held: 4 });
  });

  it('returns the whole hold when the work fails', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'topup', amount: 3, key: 'g', reason: 'test' });
    const h = await credits.hold({ workspaceId: ws, amount: 3, key: 'h', reason: 'image' });
    await credits.release({ workspaceId: ws, holdId: h.holdId, reason: 'image failed' });
    expect(await credits.balance(ws)).toMatchObject({ topup: 3, held: 0 });
  });

  it('expires unused plan credits but keeps top-ups', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 100, key: 'g', reason: 'test' });
    await credits.grant({ workspaceId: ws, bucket: 'topup', amount: 50, key: 't', reason: 'test' });
    expect(await credits.expirePlanCredits({ workspaceId: ws, key: 'expire:p1' })).toBe(100);
    expect(await credits.expirePlanCredits({ workspaceId: ws, key: 'expire:p1' })).toBe(0);
    expect(await credits.balance(ws)).toMatchObject({ plan: 0, topup: 50 });
  });

  it('keeps the ledger and the balance in agreement', async () => {
    const ws = newWs();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 20, key: 'g', reason: 'test' });
    const h = await credits.hold({ workspaceId: ws, amount: 6, key: 'h', reason: 'x' });
    await credits.settle({ workspaceId: ws, holdId: h.holdId, actual: 9, reason: 'x (cost above hold)' });
    const sums = await conn
      .collection('credit_entries')
      .aggregate([
        { $match: { workspaceId: ws } },
        { $group: { _id: '$bucket', amount: { $sum: '$amount' }, held: { $sum: '$heldDelta' } } },
      ])
      .toArray();
    const bal = await credits.balance(ws);
    const plan = sums.find((s) => s._id === 'plan')!;
    expect(plan.amount).toBe(bal.plan);
    expect(plan.held).toBe(bal.held);
    expect(bal).toMatchObject({ plan: 11, held: 0 });
  });
});
