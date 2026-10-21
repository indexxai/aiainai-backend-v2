import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { CreditsService } from '../credits/credits.service.js';
import { ONBOARDING_PENDING, UserProfile } from '../database/schemas/user-profile.schema.js';
import { Workspace, type SpaceKind, type WorkspaceDocument } from '../database/schemas/workspace.schema.js';
import { AppError } from '../common/api-error.js';
import { requestedSpace } from '../common/space.js';

/** The space a request works in, and the workspace whose plan and credits pay for it. */
export interface SpaceScope {
  space: SpaceKind;
  workspace: WorkspaceDocument;
  billing: WorkspaceDocument;
}

import { PLAN_LIMITS, periodAt, periodEndFrom } from '../plans/plans.config.js';
import { planForPeriod } from '../billing/payments.logic.js';

/** Creates and looks up the workspace that owns a person's data. */
@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Workspace.name) private readonly workspaces: Model<Workspace>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfile>,
    private readonly credits: CreditsService,
  ) {}

  /**
   * Called once after sign-up (day 4): workspace + profile on the Free plan, then the first
   * month's plan credits. Safe to call again for the same user; it returns the existing workspace.
   */
  async ensureForUser(user: { id: string; name?: string }): Promise<WorkspaceDocument> {
    const existing = await this.profiles.findOne({ userId: user.id }).lean();
    if (existing) return this.renewIfDue((await this.workspaces.findById(existing.workspaceId))!);

    const now = new Date();
    let ws: WorkspaceDocument;
    try {
      ws = await this.connection.transaction(async (session) => {
        const [created] = await this.workspaces.create(
          [
            {
              name: user.name ? `${user.name}’s workspace` : 'My workspace',
              ownerUserId: user.id,
              plan: 'free',
              periodStart: now,
              periodEnd: periodEndFrom(now),
            },
          ],
          { session },
        );
        // New accounts are asked once whether they want Jack for personal life or a business.
        await this.profiles.create(
          [{ userId: user.id, workspaceId: created!._id, onboarding: { use: ONBOARDING_PENDING } }],
          { session },
        );
        return created!;
      });
    } catch (err) {
      // Another request created this user's workspace at the same moment (e.g. sign-up hook and
      // the first page load). Its transaction won; use that workspace.
      if ((err as { code?: number }).code !== 11000) throw err;
      const profile = await this.profiles.findOne({ userId: user.id }).lean();
      return (await this.workspaces.findById(profile!.workspaceId))!;
    }

    await this.credits.grant({
      workspaceId: ws._id,
      bucket: 'plan',
      amount: PLAN_LIMITS.free.monthlyCredits,
      key: `plan:${ws._id.toHexString()}:${ws.periodStart.toISOString()}`,
      reason: 'Jack Free monthly credits',
    });
    return ws;
  }

  /**
   * Monthly plan credits. When a period has ended, unused plan credits expire (top-ups stay)
   * and the new period's credits are granted. Runs whenever the workspace is loaded, so
   * credits are always right when someone uses the app; every step is idempotent, so two
   * requests at the same moment can't grant twice.
   *
   * Paid months (one-time payments) end at `proUntil`; after that the plan goes back to Free.
   */
  async renewIfDue(ws: WorkspaceDocument, now = new Date()): Promise<WorkspaceDocument> {
    if (ws.periodEnd > now) return ws;
    const id = ws._id.toHexString();
    const created = (ws as WorkspaceDocument & { createdAt?: Date }).createdAt ?? ws.periodStart;
    const anchor = ws.planAnchor ?? created;
    const next = periodAt(anchor <= ws.periodStart ? anchor : ws.periodStart, now);
    // A paid month of Personal that wasn't paid again ends here: back to Free.
    const plan = planForPeriod(ws, next.start);
    try {
      await this.expireWithRetry(ws, `expire:${id}:${ws.periodEnd.toISOString()}`);
      await this.credits.grant({
        workspaceId: ws._id,
        bucket: 'plan',
        amount: PLAN_LIMITS[plan].monthlyCredits,
        key: `plan:${id}:${next.start.toISOString()}`,
        reason: `${PLAN_LIMITS[plan].label} plan monthly credits`,
      });
    } catch (err) {
      // Never block the app over this; the next request tries again.
      this.logger.error({ err, workspaceId: id }, 'Renewing plan credits failed');
      return ws;
    }
    const updated = await this.workspaces.findOneAndUpdate(
      { _id: ws._id, periodEnd: ws.periodEnd },
      { $set: { plan, periodStart: next.start, periodEnd: next.end } },
      { new: true },
    );
    if (updated && plan !== ws.plan)
      await this.workspaces.updateMany({ parentWorkspaceId: ws._id }, { $set: { plan } });
    return updated ?? (await this.workspaces.findById(ws._id))!;
  }

  /**
   * The workspace this request should read and write: Business when the web app says the person
   * is in their Business space and they have one, otherwise Personal. Plan and credits always
   * come from Personal (`billing`).
   */
  async forRequest(user: { id: string; name?: string }): Promise<SpaceScope> {
    const personal = await this.ensureForUser(user);
    if (requestedSpace() === 'business') {
      const business = await this.findBusiness(personal._id);
      if (business) return { space: 'business', workspace: business, billing: personal };
    }
    return { space: 'personal', workspace: personal, billing: personal };
  }

  /** Every space the person has (Personal, then Business if set up), e.g. for Activity and Approvals. */
  async spacesFor(user: { id: string; name?: string }): Promise<SpaceScope[]> {
    const personal = await this.ensureForUser(user);
    const business = await this.findBusiness(personal._id);
    return [
      { space: 'personal', workspace: personal, billing: personal },
      ...(business ? [{ space: 'business' as const, workspace: business, billing: personal }] : []),
    ];
  }

  /** Rename the Personal assistant (null: back to Jack). */
  async setAssistantName(
    user: { id: string; name?: string },
    name: string | null,
  ): Promise<WorkspaceDocument> {
    const personal = await this.ensureForUser(user);
    await this.workspaces.updateOne({ _id: personal._id }, { $set: { assistantName: name } });
    personal.assistantName = name;
    return personal;
  }

  findBusiness(personalId: WorkspaceDocument['_id']): Promise<WorkspaceDocument | null> {
    return this.workspaces.findOne({ parentWorkspaceId: personalId, kind: 'business', deletedAt: null });
  }

  private async expireWithRetry(ws: WorkspaceDocument, key: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.credits.expirePlanCredits({ workspaceId: ws._id, key });
      } catch (err) {
        if (attempt >= 2 || !(err instanceof AppError) || err.code !== 'conflict') throw err;
      }
    }
  }
}
