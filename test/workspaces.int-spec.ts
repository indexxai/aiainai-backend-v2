import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { CreditsService } from '../src/credits/credits.service.js';
import { DataModule } from '../src/database/data.module.js';
import { Workspace } from '../src/database/schemas/workspace.schema.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';

const uri = process.env.MONGODB_TEST_URI;
const describeDb = uri ? describe : describe.skip;

describeDb('Monthly plan credits (real MongoDB)', () => {
  let svc: WorkspacesService;
  let credits: CreditsService;
  let workspaces: Model<Workspace>;
  let close: () => Promise<void>;
  const dbName = `aiainai_test_ws_${Date.now()}`;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const mod = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri!, { dbName }), DataModule, WorkspacesModule],
    }).compile();
    const app = await mod.init();
    svc = app.get(WorkspacesService);
    credits = app.get(CreditsService);
    workspaces = app.get(getModelToken(Workspace.name));
    const conn = app.get<Connection>(getConnectionToken());
    for (const m of Object.values(conn.models)) await m.syncIndexes();
    close = async () => {
      await conn.dropDatabase();
      await app.close();
    };
  });

  afterAll(async () => close?.());

  it('creates the workspace with 100 credits, then renews once per period', async () => {
    const ws = await svc.ensureForUser({ id: 'renew-user', name: 'Sara' });
    expect(await credits.balance(ws._id)).toMatchObject({ plan: 100 });
    await credits.hold({ workspaceId: ws._id, amount: 40, key: 'h', reason: 'test' });

    // Pretend the period ended yesterday.
    const ended = new Date(Date.now() - 86_400_000);
    await workspaces.updateOne({ _id: ws._id }, { $set: { periodEnd: ended } });
    const stale = (await workspaces.findById(ws._id))!;
    const [a, b] = await Promise.all([svc.renewIfDue(stale), svc.renewIfDue(stale)]);
    expect(a.periodEnd.getTime()).toBeGreaterThan(Date.now());
    expect(b.periodEnd.getTime()).toBe(a.periodEnd.getTime());
    // 60 unused expired, 100 granted once; the 40 held stay held
    expect(await credits.balance(ws._id)).toMatchObject({ plan: 100, held: 40 });
  });
});
