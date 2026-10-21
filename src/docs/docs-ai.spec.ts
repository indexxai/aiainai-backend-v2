import { Logger } from '@nestjs/common';
import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import { DocumentRecordSchema, type DocumentRecord } from '../database/schemas/document.schema.js';
import { UsageEventSchema, type UsageEvent } from '../database/schemas/usage-event.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { DemoLanguageModel } from '../models/demo-model.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { MemoryModel } from '../testing/memory-model.js';
import { assistantMessages, cleanRewrite, editMessages, MAX_DOC_CHARS } from './docs-ai.logic.js';
import { DocsService, type Actor } from './docs.service.js';

Logger.overrideLogger(false);

function setup(balance = 100) {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  vi.spyOn(models.providers, 'languageModel').mockImplementation(
    (m) => new DemoLanguageModel(m.key, m.name, 0),
  );
  const credits = new FakeCredits(balance);
  const gateway = new GatewayService(
    models,
    credits as unknown as CreditsService,
    new MemoryModel('UsageEvent', UsageEventSchema) as unknown as Model<UsageEvent>,
  );
  const docs = new MemoryModel('DocumentRecord', DocumentRecordSchema);
  const svc = new DocsService(docs as unknown as Model<DocumentRecord>, gateway, models);
  const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan: 'free' };
  const balanceOf = () => credits.balances.get(String(actor.workspaceId));
  return { svc, actor, balanceOf, docs };
}

const blank = (svc: DocsService, actor: Actor) =>
  svc.create(actor, { title: 'Website proposal', type: 'proposal', sections: [] });

describe('docs AI logic', () => {
  it('builds the edit prompt from an action or an instruction', () => {
    const a = editMessages({ text: 'Hello there.', action: 'translate', language: 'Spanish', title: 'T' });
    expect(a.prompt).toContain('Translate it into Spanish.');
    expect(a.prompt).toContain('<<<\nHello there.\n>>>');
    const b = editMessages({ text: 'x', instruction: 'Make it punchier', title: 'T' });
    expect(b.prompt).toContain('Instruction: Make it punchier');
  });

  it('cuts very long documents, keeping the sections the request names', () => {
    const one = assistantMessages({
      title: 'T',
      markdown: 'a'.repeat(MAX_DOC_CHARS + 10),
      message: 'hi',
      history: [],
    });
    expect(one.truncated).toBe(true);
    expect(one.messages.at(-1)!.content).toContain('[…the rest of this section is not shown]');

    const big = 'x '.repeat(MAX_DOC_CHARS / 3);
    const markdown = `## Summary\n\n${big}\n\n## Scope\n\n${big}\n\n## Pricing\n\n${big}\n\n## Team\n\nSmall.`;
    const m = assistantMessages({ title: 'T', markdown, message: 'Tighten the pricing', history: [] });
    expect(m.truncated).toBe(true);
    const sent = m.messages.at(-1)!.content;
    expect(sent).toContain('## Pricing\n\nx x');
    expect(sent).toContain('[…not shown]');
    expect(sent).toContain('Sections: Summary · Scope · Pricing · Team');
    expect(
      assistantMessages({ title: 'T', markdown: '## A\n\nHi', message: 'hi', history: [] }).truncated,
    ).toBe(false);
  });

  it('strips quotes and markers around a rewrite', () => {
    expect(cleanRewrite('“A short line.”')).toBe('A short line.');
    expect(cleanRewrite('<<<\nText\n>>>')).toBe('Text');
    expect(cleanRewrite('He said “hi” to me')).toBe('He said “hi” to me');
  });
});

describe('DocsService AI editing', () => {
  it('suggests a rewrite for one message’s credits and counts it on the document', async () => {
    const { svc, actor, balanceOf } = setup();
    const doc = await blank(svc, actor);
    const r = await svc.aiEdit(actor, doc.id, {
      text: 'We don’t think it’s ready. We can’t ship it yet.',
      action: 'formal',
    });
    expect(r.text).toBe('We do not think it is ready. We cannot ship it yet.');
    // Auto for a short edit picks the cheapest model (1 credit)
    expect(r.credits).toBe(1);
    expect(balanceOf()).toBe(99);
    expect((await svc.get(actor, doc.id)).credits).toBe(1);
  });

  it('drafts a section to insert, or answers about the document', async () => {
    const { svc, actor } = setup();
    const doc = await blank(svc, actor);
    const markdown = '## Summary\n\nWe relaunch the site.\n\n## Scope\n\nFive pages.';
    const add = await svc.assistant(actor, doc.id, {
      message: 'Write a next steps section',
      markdown,
      history: [],
    });
    expect(add.insert?.heading).toBe('Next steps');
    expect(add.insert?.markdown.startsWith('## Next steps')).toBe(true);
    expect(add.insert?.replaces).toBeNull();

    const tighten = await svc.assistant(actor, doc.id, {
      message: 'Tighten the summary',
      markdown,
      history: [],
    });
    expect(tighten.insert).toMatchObject({ heading: 'Summary', replaces: 'Summary', after: null });
    expect(add.truncated).toBe(false);

    const ask = await svc.assistant(actor, doc.id, { message: 'What is missing?', markdown, history: [] });
    expect(ask.insert).toBeNull();
    expect(ask.reply).toContain('2 sections');
  });

  it('refuses while the document is being written, and without credits', async () => {
    const { svc, actor, docs } = setup(0);
    const doc = await blank(svc, actor);
    await expect(svc.aiEdit(actor, doc.id, { text: 'Hi', action: 'grammar' })).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    docs.docs[0]!.status = 'writing';
    docs.docs[0]!.updatedAt = new Date();
    await expect(svc.aiEdit(actor, doc.id, { text: 'Hi', action: 'grammar' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
