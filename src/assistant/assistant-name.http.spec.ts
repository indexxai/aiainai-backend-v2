import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayService, type GatewayRequest } from '../gateway/gateway.service.js';
import { signedInApp } from '../testing/http-session.js';
import { cleanAssistantName } from './assistant-name.js';

describe('naming the assistant', () => {
  it('tidies good names and refuses bad ones', () => {
    expect(cleanAssistantName('  Max  ')).toBe('Max');
    expect(cleanAssistantName('Mary  Jane')).toBe('Mary Jane');
    expect(cleanAssistantName("D'Artagnan")).toBe("D'Artagnan");
    expect(cleanAssistantName('علی')).toBe('علی');
    expect(cleanAssistantName('R2-D2')).toBe('R2-D2');
    expect(cleanAssistantName('')).toBeNull();
    expect(cleanAssistantName('jack')).toBeNull();
    expect(cleanAssistantName('Jack of all trades')).toBeNull();
    expect(() => cleanAssistantName('A name that is far too long')).toThrow(/20 characters/);
    expect(() => cleanAssistantName('Max 🚀')).toThrow(/letters and numbers/);
    expect(() => cleanAssistantName('<b>Max</b>')).toThrow(/letters and numbers/);
    expect(() => cleanAssistantName('Chat GPT')).toThrow(/another assistant/);
    expect(() => cleanAssistantName('captain-jack')).toThrow(/another assistant/);
  });
});

describe('naming the assistant over HTTP', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  const seen: GatewayRequest[] = [];

  beforeAll(async () => {
    s = await signedInApp({ email: 'rename@example.com' });
    const gw = s.app.get(GatewayService);
    const stream = gw.stream.bind(gw);
    gw.stream = (req: GatewayRequest) => {
      seen.push(req);
      return stream(req);
    };
  });
  afterAll(async () => s?.close());

  it('starts as Jack, renames, and goes back', async () => {
    expect((await s.call.get('/me').expect(200)).body.assistant).toEqual({
      name: 'Jack',
      title: 'Jack of all trades',
      custom: false,
    });
    const r = await s.call.patch('/me/assistant', { name: ' Max ' }).expect(200);
    expect(r.body).toEqual({ name: 'Max', title: 'Max', custom: true });
    expect((await s.call.get('/me').expect(200)).body.assistant.name).toBe('Max');

    await s.call.patch('/me/assistant', { name: 'Claude' }).expect(422);
    await s.call.patch('/me/assistant', { nope: 1 }).expect(422);
    expect((await s.call.get('/me').expect(200)).body.assistant.name).toBe('Max');
  });

  it('the renamed assistant knows his name, and Business keeps Captain Jack', async () => {
    await s.call.patch('/me/assistant', { name: 'Max' }).expect(200);
    await s.ask('Hello there');
    expect(seen.at(-1)!.system).toMatch(/You are Max/);
    expect(seen.at(-1)!.system).not.toMatch(/Captain Jack/);

    await s.addBusiness();
    await s.ask('Hello there', 'business');
    expect(seen.at(-1)!.system).toMatch(/You are Captain Jack/);

    const act = await s.call.get('/activity').expect(200);
    const talk = act.body.items.find(
      (i: { kind: string; space: string }) => i.kind === 'conversation' && i.space === 'personal',
    );
    expect(talk.text).toMatch(/^talked with Max:/);

    await s.call.patch('/me/assistant', { name: '' }).expect(200);
    await s.ask('Hello again');
    expect(seen.at(-1)!.system).toMatch(/You are Jack/);
  });
});
