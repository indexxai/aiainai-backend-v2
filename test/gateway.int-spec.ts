import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { CreditsService } from '../src/credits/credits.service.js';
import { DataModule } from '../src/database/data.module.js';
import { AiModel } from '../src/database/schemas/ai-model.schema.js';
import { UsageEvent } from '../src/database/schemas/usage-event.schema.js';
import { GatewayModule } from '../src/gateway/gateway.module.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { MODEL_SEED } from '../src/models/registry.seed.js';

const uri = process.env.MONGODB_TEST_URI;
const describeDb = uri ? describe : describe.skip;

/** Gateway + real credits ledger + real registry, answering with the stand-in model. */
describeDb('GatewayService (real MongoDB, stand-in model)', () => {
  let gateway: GatewayService;
  let credits: CreditsService;
  let usage: Model<UsageEvent>;
  let close: () => Promise<void>;
  const dbName = `aiainai_test_gw_${Date.now()}`;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ NODE_ENV: 'test', AI_DEMO: true })],
        }),
        MongooseModule.forRoot(uri!, { dbName }),
        DataModule,
        GatewayModule,
      ],
    }).compile();
    const app = await mod.init();
    gateway = app.get(GatewayService);
    credits = app.get(CreditsService);
    usage = app.get(getModelToken(UsageEvent.name));
    const conn = app.get<Connection>(getConnectionToken());
    for (const m of Object.values(conn.models)) await m.syncIndexes();
    await app
      .get<Model<AiModel>>(getModelToken(AiModel.name))
      .insertMany(MODEL_SEED.map((m) => ({ ...m, providerModelId: '', status: 'hidden' })));
    close = async () => {
      await conn.dropDatabase();
      await app.close();
    };
  });

  afterAll(async () => close?.());

  it('charges one message from the ledger and logs usage', async () => {
    const ws = new Types.ObjectId();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 10, key: 'g', reason: 'test' });
    const events = [];
    for await (const e of gateway.stream({
      workspaceId: ws,
      userId: 'u1',
      plan: 'free',
      tool: 'chat',
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      key: 'm1',
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'ok', credits: 2 });
    expect(await credits.balance(ws)).toMatchObject({ plan: 8, held: 0 });
    expect(await usage.countDocuments({ workspaceId: ws, outcome: 'ok', credits: 2 })).toBe(1);
  });

  it('returns credits when stopped before any text', async () => {
    const ws = new Types.ObjectId();
    await credits.grant({ workspaceId: ws, bucket: 'plan', amount: 10, key: 'g', reason: 'test' });
    const ac = new AbortController();
    ac.abort();
    for await (const _ of gateway.stream({
      workspaceId: ws,
      userId: 'u1',
      plan: 'free',
      tool: 'chat',
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
      key: 'm2',
      abortSignal: ac.signal,
    }));
    expect(await credits.balance(ws)).toMatchObject({ plan: 10, held: 0 });
  });
});
