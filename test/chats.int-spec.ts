import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { ChatsModule } from '../src/chats/chats.module.js';
import { ChatsService, type Actor, type StreamEvent } from '../src/chats/chats.service.js';
import { CreditsService } from '../src/credits/credits.service.js';
import { DataModule } from '../src/database/data.module.js';
import { AiModel } from '../src/database/schemas/ai-model.schema.js';
import { MODEL_SEED } from '../src/models/registry.seed.js';

const uri = process.env.MONGODB_TEST_URI;
const describeDb = uri ? describe : describe.skip;

/** Chats on a real MongoDB (queries, ordering, updates), answered by the stand-in model. */
describeDb('ChatsService (real MongoDB)', () => {
  let chats: ChatsService;
  let credits: CreditsService;
  let close: () => Promise<void>;
  const dbName = `aiainai_test_chat_${Date.now()}`;

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
        ChatsModule,
      ],
    }).compile();
    const app = await mod.init();
    chats = app.get(ChatsService);
    credits = app.get(CreditsService);
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

  const drain = async (it: AsyncIterable<StreamEvent>) => {
    const out: StreamEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it('sends, stores, lists, regenerates and charges through the ledger', async () => {
    const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan: 'free' };
    await credits.grant({
      workspaceId: actor.workspaceId,
      bucket: 'plan',
      amount: 20,
      key: 'g',
      reason: 'test',
    });
    const chat = await chats.create(actor, {});
    const ev = await drain(
      chats.stream(
        await chats.prepareSend(actor, chat.id, { text: 'Bakery tagline', model: 'claude-sonnet' }),
        new AbortController().signal,
      ),
    );
    const end = ev.at(-1)!;
    expect(end.event).toBe('done');
    const answerId = (end.data as { message: { id: string } }).message.id;

    const again = await drain(
      chats.stream(await chats.prepareRegenerate(actor, chat.id, answerId, {}), new AbortController().signal),
    );
    expect(again.at(-1)!.event).toBe('done');

    const detail = await chats.get(actor, chat.id);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.chat.title).toBe('Bakery tagline');
    expect((await chats.list(actor, { q: 'bakery' })).items).toHaveLength(1);
    expect(await credits.balance(actor.workspaceId)).toMatchObject({ plan: 16, held: 0 });
  });
});
