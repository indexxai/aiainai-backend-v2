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
import { liveRuns, runKey } from '../common/live-runs.js';
import { DocVersionSchema, type DocVersion } from '../database/schemas/doc-version.schema.js';
import { AUTO_VERSION_MS, DocsVersionsService } from './docs-versions.service.js';
import { DocsService, type Actor, type DocStreamEvent } from './docs.service.js';

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
  const versionRows = new MemoryModel('DocVersion', DocVersionSchema);
  const versions = new DocsVersionsService(
    versionRows as unknown as Model<DocVersion>,
    docs as unknown as Model<DocumentRecord>,
  );
  const svc = new DocsService(docs as unknown as Model<DocumentRecord>, gateway, models, versions);
  const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan: 'free' };
  const balanceOf = () => credits.balances.get(String(actor.workspaceId));
  return { svc, actor, balanceOf, docs, versions, versionRows };
}

/** Collects events; with `stopAt`, aborts once the text written so far satisfies it. */
async function drain(
  it: AsyncIterable<DocStreamEvent>,
  stopAt?: (text: string) => boolean,
  ac?: AbortController,
) {
  const out: DocStreamEvent[] = [];
  let text = '';
  for await (const e of it) {
    out.push(e);
    if (e.event === 'delta') {
      text += e.data.text;
      if (stopAt?.(text) && !ac?.signal.aborted) ac?.abort();
    }
  }
  return out;
}

const sections = [
  { heading: 'Summary', note: 'From your brief' },
  { heading: 'Scope', note: '' },
  { heading: 'Timeline', note: '' },
  { heading: 'Team', note: '' },
];

describe('DocsService', () => {
  it('suggests an outline for 1 credit and estimates writing costs', async () => {
    const { svc, actor, balanceOf } = setup();
    const o = await svc.outline(actor, { brief: 'a proposal for a website relaunch', type: 'proposal' });
    expect(o.sections.map((s) => s.heading)).toEqual(['Summary', 'Scope', 'Timeline', 'Team', 'Next steps']);
    expect(o.title).toBe('A proposal for a website relaunch');
    expect(o.credits).toBe(1);
    expect(balanceOf()).toBe(99);
    // Auto for a document picks the balanced model (Claude Sonnet, 2 credits)
    expect(await svc.estimates(actor)).toEqual({
      short: { credits: 4, words: 450 },
      medium: { credits: 6, words: 1100 },
      long: { credits: 10, words: 2200 },
    });
  });

  it('writes every section, saves the draft and charges the document price', async () => {
    const { svc, actor, balanceOf } = setup();
    const doc = await svc.create(actor, { title: 'Proposal', type: 'proposal', sections, length: 'medium' });
    expect(doc.status).toBe('draft');
    const events = await drain(
      svc.write(await svc.prepareWrite(actor, doc.id), new AbortController().signal),
    );
    const end = events.at(-1)!;
    expect(end.event).toBe('done');
    const saved = (
      end.data as {
        doc: { status: string; markdown: string; credits: number; sectionsDone: number; wordCount: number };
      }
    ).doc;
    expect(saved).toMatchObject({ status: 'ready', credits: 6, sectionsDone: 4 });
    expect(saved.markdown.match(/^## /gm)).toHaveLength(4);
    expect(saved.wordCount).toBeGreaterThan(50);
    expect(balanceOf()).toBe(94);
    await expect(svc.prepareWrite(actor, doc.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('Stop keeps finished sections, charges only for them, and Continue writes the rest', async () => {
    const { svc, actor, balanceOf } = setup();
    const doc = await svc.create(actor, { title: 'Proposal', type: 'proposal', sections, length: 'medium' });
    const ac = new AbortController();
    // Stop part-way through the third section.
    const first = await drain(
      svc.write(await svc.prepareWrite(actor, doc.id), ac.signal),
      (t) => /## Timeline\n\nThis is sample/.test(t),
      ac,
    );
    const stopped = (
      first.at(-1)!.data as {
        doc: { status: string; sectionsDone: number; credits: number; markdown: string };
      }
    ).doc;
    expect(stopped.status).toBe('stopped');
    expect(stopped.sectionsDone).toBe(2);
    expect(stopped.markdown.match(/^## /gm)).toHaveLength(2);
    expect(stopped.credits).toBe(3); // 6 credits × 2 of 4 sections
    expect(balanceOf()).toBe(97);

    const rest = await drain(svc.write(await svc.prepareWrite(actor, doc.id), new AbortController().signal));
    const done = (
      rest.at(-1)!.data as {
        doc: { status: string; sectionsDone: number; credits: number; markdown: string };
      }
    ).doc;
    expect(done.status).toBe('ready');
    expect(done.markdown.match(/^## /gm)!.length).toBe(4);
    expect(done.markdown).toContain('## Summary');
    expect(done.markdown).toContain('## Team');
    expect(done.credits).toBe(6);
    expect(balanceOf()).toBe(94);
  });

  it('Stop is its own call: it stops writing here, or stops a document left writing', async () => {
    const { svc, actor } = setup();
    const doc = await svc.create(actor, { title: 'Proposal', type: 'proposal', sections, length: 'medium' });
    expect(await svc.stop(actor, doc.id)).toEqual({ stopped: false });

    const key = runKey.doc(doc.id);
    const run = liveRuns.start(key);
    let asked = false;
    let last: DocStreamEvent | undefined;
    for await (const e of svc.write(await svc.prepareWrite(actor, doc.id), run.signal)) {
      last = e;
      if (e.event === 'delta' && !asked) {
        asked = true;
        expect(await svc.stop(actor, doc.id)).toEqual({ stopped: true });
      }
    }
    liveRuns.end(key, run);
    expect((last!.data as { doc: { status: string } }).doc.status).toBe('stopped');

    // Left writing with no run here (restart, another server): stop keeps whole sections only.
    await svc.prepareWrite(actor, doc.id);
    expect(await svc.stop(actor, doc.id)).toEqual({ stopped: true });
    expect((await svc.get(actor, doc.id)).status).toBe('stopped');
  });

  it('keeps versions: first draft, every few minutes while editing, AI changes, named, restore', async () => {
    const { svc, actor, versions, versionRows } = setup();
    const doc = await svc.create(actor, { title: 'Proposal', type: 'proposal', sections, length: 'short' });
    await expect(versions.name(actor, doc.id)).rejects.toMatchObject({ code: 'conflict' });
    await drain(svc.write(await svc.prepareWrite(actor, doc.id), new AbortController().signal));
    let list = await versions.list(actor, doc.id);
    expect(list.map((v) => [v.kind, v.name, v.by])).toEqual([['first', 'First draft', 'you']]);

    const edit = (t: string, aiChange?: string) =>
      svc.update(actor, doc.id, {
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] },
        text: t,
        ...(aiChange && { aiChange }),
      });
    // Edits right after the draft don't add versions; a few minutes later the replaced text is kept.
    await edit('one');
    await edit('two');
    expect(await versions.list(actor, doc.id)).toHaveLength(1);
    for (const v of versionRows.docs) v.createdAt = new Date(Date.now() - AUTO_VERSION_MS - 1000);
    await edit('three');
    list = await versions.list(actor, doc.id);
    expect(list.map((v) => v.kind)).toEqual(['auto', 'first']);
    expect((await versions.get(actor, doc.id, list[0]!.id)).content).toMatchObject({
      content: [{ content: [{ text: 'two' }] }],
    });

    // An accepted AI change: the text before it is kept, and the change itself.
    await edit('four, shorter', 'Made shorter');
    list = await versions.list(actor, doc.id);
    expect(list.slice(0, 2).map((v) => [v.kind, v.name, v.by])).toEqual([
      ['ai', 'AI change: Made shorter', 'assistant'],
      ['auto', 'Auto-saved', 'you'],
    ]);

    const named = await versions.name(actor, doc.id, 'Sent to client');
    expect(named).toMatchObject({ kind: 'named', name: 'Sent to client', named: true });
    expect((await versions.name(actor, doc.id)).name).toBe('Version 2');

    // Restore the first draft; the current text is kept first, so it can be undone.
    const first = list.find((v) => v.kind === 'first')!;
    await versions.restore(actor, doc.id, first.id);
    const restored = await svc.get(actor, doc.id);
    expect(restored.content).toBeNull();
    expect(restored.markdown).toContain('## Summary');
    list = await versions.list(actor, doc.id);
    expect(list[0]).toMatchObject({ kind: 'restore', name: 'Before restoring “First draft”' });

    // Other workspaces can't see them; Free keeps 7 days (named ones stay).
    await expect(versions.list({ ...actor, workspaceId: new Types.ObjectId() }, doc.id)).rejects.toThrow();
    const old = new Date(Date.now() - 8 * 86_400_000);
    for (const v of versionRows.docs) v.createdAt = old;
    list = await versions.list(actor, doc.id);
    expect(list.map((v) => v.kind)).toEqual(['named', 'named']);
    expect((await versions.list({ ...actor, plan: 'pro' }, doc.id)).length).toBe(2);
  });

  it('refuses edits while writing, then autosaves editor content', async () => {
    const { svc, actor } = setup();
    const doc = await svc.create(actor, { title: 'Plan', type: 'plan', sections, length: 'short' });
    const run = await svc.prepareWrite(actor, doc.id);
    await expect(svc.update(actor, doc.id, { title: 'X' })).rejects.toMatchObject({ code: 'conflict' });
    await drain(svc.write(run, new AbortController().signal));
    const saved = await svc.update(actor, doc.id, {
      title: 'Launch plan',
      content: { type: 'doc' },
      text: 'one two three',
    });
    expect(saved).toMatchObject({ title: 'Launch plan', wordCount: 3, content: { type: 'doc' } });
  });

  it('creates blank documents, lists and searches, deletes, and keeps workspaces apart', async () => {
    const { svc, actor } = setup();
    const blank = await svc.create(actor, { title: 'Meeting notes', type: 'meeting-notes', sections: [] });
    expect(blank.status).toBe('ready');
    await svc.create(actor, { title: 'Pricing proposal', type: 'proposal', sections });
    expect((await svc.list(actor, {})).items.map((d) => d.title)).toEqual([
      'Pricing proposal',
      'Meeting notes',
    ]);
    expect((await svc.list(actor, { q: 'pric' })).items).toHaveLength(1);
    await svc.remove(actor, blank.id);
    expect((await svc.list(actor, {})).items).toHaveLength(1);
    await expect(svc.get({ ...actor, workspaceId: new Types.ObjectId() }, blank.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('saves "not enough credits" on the document instead of failing the request', async () => {
    const { svc, actor } = setup(3);
    const doc = await svc.create(actor, { title: 'Report', type: 'report', sections, length: 'medium' });
    const events = await drain(
      svc.write(await svc.prepareWrite(actor, doc.id), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      event: 'error',
      data: { doc: { status: 'failed', error: { code: 'insufficient_credits' } } },
    });
  });
});
