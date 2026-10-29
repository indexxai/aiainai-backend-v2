import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { planAfterPayment } from './billing/payments.logic.js';
import { CreditsService } from './credits/credits.service.js';
import { Workspace } from './database/schemas/workspace.schema.js';
import { PLAN_LIMITS } from './plans/plans.config.js';
import { WorkerModule } from './worker.module.js';

/**
 * Gives one person a month of Jack Personal by hand, exactly as a paid month would.
 * Usage: `nest build && node dist/grant-personal.js <email> [--apply]` (dry run without --apply).
 */
const [email, flag] = process.argv.slice(2);
if (!email) throw new Error('Usage: grant-personal <email> [--apply]');
const apply = flag === '--apply';

const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
const workspaces = ctx.get<Model<Workspace>>(getModelToken(Workspace.name));
const credits = ctx.get(CreditsService);

const user = await workspaces.db.collection('user').findOne({ email: email.toLowerCase() });
if (!user) throw new Error(`No user with email ${email}`);
const ws = await workspaces
  .findOne({ ownerUserId: String(user._id), kind: 'personal', deletedAt: null })
  .lean();
if (!ws) throw new Error(`No Personal workspace for ${email}`);

const key = `manual:${ws._id.toHexString()}:${new Date().toISOString()}`;
const change = planAfterPayment(ws, new Date());
console.log({ userId: String(user._id), workspaceId: ws._id.toHexString(), current: ws.plan, change });

if (apply) {
  const res = await workspaces.updateOne(
    { _id: ws._id, plan: ws.plan, periodEnd: ws.periodEnd },
    { $set: change.set, $push: { appliedPayments: `${key}|${change.mode}` } },
  );
  if (!res.matchedCount) throw new Error('Workspace changed while updating; run again.');
  if (change.mode === 'upgrade') {
    await workspaces.updateMany(
      { parentWorkspaceId: ws._id },
      { $set: { plan: 'pro', periodStart: change.set.periodStart, periodEnd: change.set.periodEnd } },
    );
    await credits.expirePlanCredits({
      workspaceId: ws._id,
      key: `upgrade:${key}`,
      reason: 'Free plan credits replaced by Jack Personal',
    });
    await credits.grant({
      workspaceId: ws._id,
      bucket: 'plan',
      amount: PLAN_LIMITS.pro.monthlyCredits,
      key,
      reason: `${PLAN_LIMITS.pro.label} · 1 month given by hand`,
    });
  }
  console.log('Applied.', await workspaces.findById(ws._id).lean());
} else {
  console.log('Dry run. Add --apply to make the change.');
}
await ctx.close();
process.exit(0);
