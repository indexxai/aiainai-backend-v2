import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../common/api-error.js';
import { BrowserTask, type BrowserView } from '../database/schemas/browser-task.schema.js';
import type { Plan, SpaceKind } from '../database/schemas/workspace.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { AUTO } from '../models/models.logic.js';
import { ActionsService } from '../actions/actions.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { step } from './browser.logic.js';
import type { BrowserTaskDto } from './browser.dto.js';
import { BROWSER_DRIVER, type BrowserDriver, type Decision, type Observation } from './driver.js';

export interface BrowserActor {
  userId: string;
  workspaceId: Types.ObjectId;
  plan: Plan;
  space?: SpaceKind;
}

type Lean = BrowserTask & { _id: Types.ObjectId; createdAt: Date };
export type BrowserControl = 'pause' | 'resume' | 'takeover' | 'giveback' | 'stop';

const decisionSchema = z.object({
  action: z.enum(['goto', 'click', 'fill', 'search', 'done', 'checkout']),
  target: z.number().int(),
  value: z.string().max(2000),
  note: z.string().max(120),
  item: z.string().max(200),
  seller: z.string().max(120),
  amount: z.number(),
});

const decideSystem = (canSearch: boolean) =>
  [
    'You control a web browser for Captain Jack to reach the person’s goal. Each turn, pick ONE action:',
    'goto (value: a URL), click (target: element number), fill (target, value: text to type),',
    ...(canSearch
      ? [
          'search (value: what to look for; the results come back in "results" with their URLs),',
          'done (value: what you found for the person, in Markdown: a short intro line, then a list with',
        ]
      : ['done (value: what you found for the person, in Markdown: a short intro line, then a list with']),
    'names, prices, places and the source site when the goal asks for options; a sentence or two otherwise),',
    'or checkout.',
    ...(canSearch
      ? [
          'To find sites, use search, never a search engine page (Google, Bing): those block automated',
          'browsers with security checks. Then goto the best result URLs and read the sites themselves.',
        ]
      : []),
    'checkout: when the next step would be paying (a payment or card page, or a final "Pay"/"Place order"',
    'button): stop and give item, seller and amount (the total, in whole currency units). Never type card',
    'numbers or passwords and never press a final pay button. Do not open banking or government sites.',
    'note: what you are doing, in a few plain words. Unused fields: target -1, value "", item "", seller "", amount 0.',
  ].join(' ');

const notFound = () => new AppError('not_found', 'We can’t find that browser task.', HttpStatus.NOT_FOUND);

/**
 * Jack's browser (v2): a private browser per task, steps the person can follow live, Pause, Take
 * over and Stop, and a stop at every payment for the person's OK (a purchase in Approvals).
 */
@Injectable()
export class BrowserService implements OnModuleInit {
  private readonly logger = new Logger(BrowserService.name);

  constructor(
    @InjectModel(BrowserTask.name) private readonly tasks: Model<BrowserTask>,
    @Inject(BROWSER_DRIVER) private readonly driver: BrowserDriver,
    private readonly actions: ActionsService,
    private readonly wallet: WalletService,
    private readonly gateway: GatewayService,
  ) {}

  get available(): boolean {
    return this.driver.available;
  }

  /** Tasks left running by a restart can't continue (their browser is gone). Tidied in the background. */
  onModuleInit() {
    if (process.env.DB_LAZY_CONNECT) return; // describing the API (openapi export): no database
    void this.tasks
      .updateMany(
        { status: { $in: ['running', 'paused', 'taken_over'] } },
        {
          $set: { status: 'failed', summary: 'Stopped by a server restart. Ask Jack to try again.' },
          $push: { steps: step('Stopped by a server restart', 'failed') },
        },
      )
      .catch((err: unknown) => this.logger.warn({ err }, 'Could not tidy browser tasks'));
  }

  async start(
    actor: BrowserActor,
    input: { goal: string; title: string; chatId?: Types.ObjectId | null; model?: string },
  ): Promise<Lean> {
    const opened = await this.driver.open();
    const row = await this.tasks.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      chatId: input.chatId ?? null,
      goal: input.goal.slice(0, 2000),
      title: input.title.slice(0, 120),
      status: 'running',
      steps: [],
      liveUrl: opened.liveUrl,
      providerRef: opened.ref,
    });
    const task = row.toObject() as unknown as Lean;
    void this.drive(actor, task, input.model ?? AUTO).catch((err: unknown) =>
      this.logger.error({ err, taskId: String(task._id) }, 'Browser task crashed'),
    );
    return task;
  }

  private async drive(actor: BrowserActor, task: Lean, model: string) {
    const id = task._id;
    const { currency } = await this.wallet.get(actor.workspaceId);
    const save = (update: Record<string, unknown>) => this.tasks.updateOne({ _id: id }, update);
    const hooks = {
      step: async (text: string, view?: BrowserView) => {
        await save({ $push: { steps: step(text, 'done') }, ...(view && { $set: { view } }) });
      },
      purchaseReady: async (p: { item: string; seller: string; amount: number; site: string }) => {
        const action = await this.actions.request({
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          kind: 'purchase',
          title: `Pay for ${p.item}`.slice(0, 200),
          payload: { ...p, currency },
          chatId: task.chatId ?? null,
          browserTaskId: id,
        });
        await save({
          $set: {
            status: 'waiting',
            actionId: action._id,
            summary: `Ready to pay ${currency} ${p.amount.toLocaleString('en-US')} to ${p.seller}`,
          },
          $push: { steps: step('Payment — waiting for your OK', 'needs_you') },
        });
      },
      done: async (summary: string) => {
        await save({ $set: { status: 'done', summary }, $push: { steps: step(summary, 'done') } });
      },
      fail: async (reason: string) => {
        await save({ $set: { status: 'failed', summary: reason }, $push: { steps: step(reason, 'failed') } });
      },
      state: async () => {
        const t = await this.tasks.findById(id, { status: 1 }).lean<Pick<BrowserTask, 'status'>>();
        return t?.status === 'running'
          ? 'go'
          : t?.status === 'paused' || t?.status === 'taken_over'
            ? 'wait'
            : 'stop';
      },
      blocked: (url: string) => this.wallet.siteBlocked(actor.workspaceId, url),
      scheme: async () => {
        const t = await this.tasks.findById(id, { scheme: 1 }).lean<Pick<BrowserTask, 'scheme'>>();
        return t?.scheme === 'dark' ? ('dark' as const) : ('light' as const);
      },
      needsYou: async (reason: string) => {
        await this.tasks.updateOne(
          { _id: id, status: 'running' },
          { $set: { status: 'paused' }, $push: { steps: step(reason, 'needs_you') } },
        );
      },
    } as const;
    const canSearch = this.driver.live && (await this.gateway.canWebSearch());
    try {
      await this.driver.run(task.providerRef, task.goal, hooks, {
        currency,
        decide: (o) => this.decide(actor, task, o, model, canSearch),
        search: canSearch ? (q) => this.search(actor, task, q, model) : undefined,
      });
    } catch (err) {
      this.logger.warn({ err, taskId: String(id) }, 'Browser task failed');
      await hooks.fail(
        err instanceof AppError ? err.message : 'The browser stopped working. Nothing was paid.',
      );
    }
    // Release the hosted browser once the task has ended (it is billed while open). A payment
    // waiting for the person keeps it open so they can look at the page; it times out by itself.
    const end = await this.tasks.findById(id, { status: 1 }).lean<Pick<BrowserTask, 'status'>>();
    if (end?.status !== 'waiting') await this.driver.close(task.providerRef).catch(() => undefined);
  }

  /** A web search for the browser (no search engine page, so no CAPTCHA), charged like a model call. */
  private async search(actor: BrowserActor, task: Lean, query: string, model: string) {
    return this.gateway.webSearch({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'browser',
      model,
      query: query.slice(0, 300),
      key: `browser-search:${task._id.toHexString()}:${new Types.ObjectId().toHexString()}`,
      ref: { kind: 'browser', id: task._id.toHexString() },
    });
  }

  /** One browsing decision through the model gateway (charged like any model call). */
  private async decide(
    actor: BrowserActor,
    task: Lean,
    o: Observation,
    model: string,
    canSearch: boolean,
  ): Promise<Decision> {
    const key = new Types.ObjectId().toHexString();
    const r = await this.gateway.object({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'browser',
      model,
      system: decideSystem(canSearch),
      messages: [{ role: 'user', content: JSON.stringify(o) }],
      key: `browser:${task._id.toHexString()}:${key}`,
      ref: { kind: 'browser', id: task._id.toHexString() },
      schema: decisionSchema,
    });
    return r.object;
  }

  async get(actor: BrowserActor, id: string): Promise<BrowserTaskDto> {
    return this.toDto(actor, await this.find(actor, id));
  }

  async control(actor: BrowserActor, id: string, what: BrowserControl): Promise<BrowserTaskDto> {
    const task = await this.find(actor, id);
    type S = BrowserTask['status'];
    const moves: Record<BrowserControl, { from: S[]; to: S; text: string }> = {
      pause: { from: ['running'], to: 'paused', text: 'You paused the browser' },
      resume: { from: ['paused'], to: 'running', text: 'The browser carried on' },
      takeover: { from: ['running', 'paused'], to: 'taken_over', text: 'You took over the browser' },
      giveback: { from: ['taken_over'], to: 'running', text: 'You handed the browser back' },
      stop: {
        from: ['running', 'paused', 'taken_over', 'waiting'],
        to: 'stopped',
        text: 'You stopped the task',
      },
    };
    const m = moves[what];
    const res = await this.tasks.updateOne(
      { _id: task._id, status: { $in: m.from } },
      {
        $set: { status: m.to, ...(what === 'stop' && { summary: 'Stopped by you. Nothing was paid.' }) },
        $push: { steps: step(m.text, what === 'stop' ? 'failed' : 'done') },
      },
    );
    if (!res.modifiedCount)
      throw new AppError('conflict', 'That can’t be done right now.', HttpStatus.CONFLICT, {
        status: task.status,
      });
    if (what === 'stop') {
      await this.actions.cancelForTask(task._id);
      await this.driver.close(task.providerRef).catch(() => undefined);
    }
    return this.get(actor, id);
  }

  /** Show sites dark or light to match the person's app theme (applied while Jack is browsing). */
  async appearance(actor: BrowserActor, id: string, scheme: 'light' | 'dark'): Promise<void> {
    const task = await this.find(actor, id);
    await this.tasks.updateOne({ _id: task._id }, { $set: { scheme } });
  }

  private async find(actor: BrowserActor, id: string): Promise<Lean> {
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const t = await this.tasks
      .findOne({ _id: new Types.ObjectId(id), workspaceId: actor.workspaceId })
      .lean<Lean>();
    if (!t) throw notFound();
    return t;
  }

  /** For Jack's plan: the task's state, and its waiting purchase. */
  async state(workspaceId: Types.ObjectId, id: string): Promise<Lean | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.tasks.findOne({ _id: new Types.ObjectId(id), workspaceId }).lean<Lean>();
  }

  private async toDto(actor: BrowserActor, t: Lean): Promise<BrowserTaskDto> {
    const action = t.actionId ? await this.actions.get(actor.workspaceId, String(t.actionId)) : null;
    return {
      id: t._id.toHexString(),
      title: t.title,
      goal: t.goal,
      status: t.status,
      steps: (t.steps ?? []).map((s) => ({ at: new Date(s.at).toISOString(), text: s.text, state: s.state })),
      view: t.view ?? null,
      liveUrl: t.liveUrl ?? null,
      sample: !this.driver.live,
      chatId: t.chatId ? String(t.chatId) : null,
      action: action ? await this.actions.toDto(action, actor.space ?? 'personal') : null,
      summary: t.summary ?? '',
      createdAt: new Date(t.createdAt).toISOString(),
    };
  }
}
