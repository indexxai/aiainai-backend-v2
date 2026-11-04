import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuthModule } from './auth/auth.module.js';
import { AUTH } from './auth/auth.tokens.js';
import type { Auth } from './auth/auth.factory.js';
import { CreditsService } from './credits/credits.service.js';
import { Workspace } from './database/schemas/workspace.schema.js';
import { PLAN_LIMITS, monthsAfter } from './plans/plans.config.js';
import { passwordProblems } from './auth/password-policy.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';
import { WorkerModule } from './worker.module.js';

/**
 * Free "unlimited" accounts given by hand:
 * - creates the account if the email has none, email marked confirmed. Password: the one
 *   passed with --password (one --email at a time), otherwise a random one nobody sees
 *   (they set their own with "Forgot password", or use Google with the same email).
 *   --password on an existing account replaces its password,
 * - Jack Personal with no end date (a hand-given plan: 2,000 plan credits every month, never
 *   drops back to Free),
 * - plus top-up credits, which never expire (default 100,000, about $1,000 of AI use).
 *   Running it again on another day adds another top-up; the same day it adds nothing.
 *
 * Usage (dry run without --apply):
 *   nest build && node dist/grant-unlimited.js
 *   node dist/grant-unlimited.js --apply
 *   node dist/grant-unlimited.js --email=a@b.com,c@d.com --credits=50000 --apply
 *   node dist/grant-unlimited.js --email=a@b.com --password='TheirPassword1' --apply
 */
const DEFAULT_EMAILS = ['chrishumpherys@yahoo.com', 'hunter1991@yahoo.com'];

const arg = (name: string) =>
  process.argv.slice(2).find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const emails = (arg('email')?.split(',') ?? DEFAULT_EMAILS).map((e) => e.trim().toLowerCase()).filter(Boolean);
const credits = Number(arg('credits') ?? 100_000);
const apply = process.argv.includes('--apply');
const chosenPassword = arg('password');

if (!emails.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new Error('Every --email must be a valid address.');
if (chosenPassword !== undefined) {
  if (emails.length !== 1) throw new Error('--password works with exactly one --email.');
  const problems = passwordProblems(chosenPassword);
  if (problems.length) throw new Error(`Password needs: ${problems.join(', ')}`);
}
if (!Number.isInteger(credits) || credits < 0 || credits > 10_000_000) throw new Error('--credits must be 0 to 10,000,000.');

@Module({ imports: [WorkerModule, AuthModule] })
class GrantModule {}

const ctx = await NestFactory.createApplicationContext(GrantModule, { logger: ['error', 'warn'] });
const auth = ctx.get<Auth>(AUTH);
const workspaces = ctx.get<Model<Workspace>>(getModelToken(Workspace.name));
const workspaceService = ctx.get(WorkspacesService);
const creditsService = ctx.get(CreditsService);
const users = workspaces.db.collection('user');

console.log(`\nDatabase: ${workspaces.db.name}`);
console.log(`Jack Personal with no end date + ${credits.toLocaleString()} top-up credits.\n`);

for (const email of emails) {
  let user = await users.findOne({ email });
  console.log(`• ${email}: account ${user ? 'exists' : 'missing'}.`);
  if (!apply) continue;

  if (!user) {
    // Random password (letters, digits, symbol) that is never shown; "Forgot password" sets theirs.
    const password = chosenPassword ?? `${randomBytes(18).toString('base64url')}a1!`;
    await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
    await users.updateOne({ email }, { $set: { emailVerified: true } });
    user = await users.findOne({ email });
    if (!user) throw new Error(`Could not create an account for ${email}`);
    console.log(`  account created (email marked confirmed, ${chosenPassword ? 'with the given password' : 'random password'}).`);
  } else if (chosenPassword) {
    // Existing account: replace the email+password login, or add one (e.g. Google-only accounts).
    const ac = await auth.$context;
    const hash = await ac.password.hash(chosenPassword);
    const userId = String(user._id);
    const credential = await workspaces.db.collection('account').findOne({ userId: user._id, providerId: 'credential' })
      ?? await workspaces.db.collection('account').findOne({ userId, providerId: 'credential' });
    if (credential) await ac.internalAdapter.updatePassword(userId, hash);
    else await ac.internalAdapter.linkAccount({ userId, providerId: 'credential', accountId: userId, password: hash });
    await users.updateOne({ email }, { $set: { emailVerified: true } });
    console.log('  password set to the given one.');
  }

  const ws = await workspaceService.ensureForUser({ id: String(user._id), name: String(user.name ?? '') });
  const now = new Date();
  if (ws.plan !== 'pro') {
    const set = { plan: 'pro' as const, planAnchor: now, periodStart: now, periodEnd: monthsAfter(now, 1), proUntil: null };
    await workspaces.updateOne({ _id: ws._id }, { $set: set });
    await workspaces.updateMany(
      { parentWorkspaceId: ws._id },
      { $set: { plan: 'pro', periodStart: set.periodStart, periodEnd: set.periodEnd } },
    );
    await creditsService.expirePlanCredits({
      workspaceId: ws._id,
      key: `unlimited-upgrade:${ws._id.toHexString()}`,
      reason: 'Free plan credits replaced by Jack Personal',
    });
    await creditsService.grant({
      workspaceId: ws._id,
      bucket: 'plan',
      amount: PLAN_LIMITS.pro.monthlyCredits,
      key: `unlimited-plan:${ws._id.toHexString()}`,
      reason: `${PLAN_LIMITS.pro.label} · given by hand, no end date`,
    });
    console.log('  plan: Free → Jack Personal (no end date).');
  } else {
    await workspaces.updateOne({ _id: ws._id }, { $set: { proUntil: null } });
    console.log('  plan: already Jack Personal; end date removed.');
  }

  if (credits > 0) {
    await creditsService.grant({
      workspaceId: ws._id,
      bucket: 'topup',
      amount: credits,
      key: `unlimited-topup:${ws._id.toHexString()}:${now.toISOString().slice(0, 10)}`,
      reason: 'Complimentary credits given by hand',
    });
  }
  const balance = await creditsService.balance(ws._id);
  console.log(`  ✅ credits now: ${balance.plan.toLocaleString()} plan + ${balance.topup.toLocaleString()} top-up.`);
}

if (!apply) console.log('\nDry run. Add --apply to make the change.');
await ctx.close();
process.exit(0);
