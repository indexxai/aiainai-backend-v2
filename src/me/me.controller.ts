import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { isBusinessOpen } from '../common/space.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';
import {
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { ONBOARDING_PENDING, UserProfile } from '../database/schemas/user-profile.schema.js';
import { ModelsService } from '../models/models.service.js';
import { CreditsService } from '../credits/credits.service.js';
import { PLAN_LIMITS } from '../plans/plans.config.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { assistantOf, cleanAssistantName } from '../assistant/assistant-name.js';
import {
  JoinWaitlistDto,
  MeAssistantDto,
  MeDto,
  WAITLISTS,
  UpdateAssistantDto,
  MAX_GOALS,
  MeOnboardingDto,
  MePreferencesDto,
  ONBOARDING_USES,
  UpdateOnboardingDto,
  UpdatePreferencesDto,
} from './me.dto.js';

const waitlistInput = z.object({ list: z.enum(WAITLISTS) }).strict();
const assistantInput = z.object({ name: z.string().max(60) }).strict();
const preferencesInput = z.object({ textModel: z.string().trim().min(1).max(64).optional() }).strict();
const onboardingInput = z
  .object({
    use: z.enum(ONBOARDING_USES).optional(),
    goals: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[^\r\n]*$/, 'One goal per line'),
      )
      .max(MAX_GOALS)
      .optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.use !== undefined || v.goals !== undefined || v.note !== undefined, {
    message: 'Send use, goals or note',
  });

/** Goals are kept as one string (the profile's onboarding answers are all strings). */
const GOAL_SEP = '\n';

/** What the sign-up screens need from a profile. */
function onboardingDto(onboarding: Record<string, string> | undefined): MeOnboardingDto {
  const use = onboarding?.use;
  return {
    askUse: use === ONBOARDING_PENDING,
    use: use === 'personal' || use === 'business' ? use : null,
    goals: onboarding?.goals ? onboarding.goals.split(GOAL_SEP).filter(Boolean) : [],
    note: onboarding?.note ?? '',
  };
}

@ApiTags('account')
@Controller('me')
export class MeController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly credits: CreditsService,
    private readonly models: ModelsService,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfile>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in person, their workspace and credits (used by the app shell)' })
  @ApiOkResponse({ type: MeDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse })
  async me(@CurrentUser() user: SessionUser): Promise<MeDto> {
    // Normally created at sign-up; this also covers accounts created before the hook ran.
    const scope = await this.workspaces.forRequest(user);
    const ws = scope.billing;
    const [bal, profile, business] = await Promise.all([
      this.credits.balance(ws._id),
      this.profiles.findOne({ userId: user.id }, { textModel: 1, onboarding: 1, waitlist: 1 }).lean(),
      scope.space === 'business' ? scope.workspace : this.workspaces.findBusiness(ws._id),
    ]);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image ?? null,
      },
      workspace: {
        id: ws._id.toHexString(),
        name: ws.name,
        plan: ws.plan,
        periodEnd: ws.periodEnd.toISOString(),
      },
      credits: { ...bal, monthly: PLAN_LIMITS[ws.plan].monthlyCredits },
      preferences: { textModel: profile?.textModel ?? 'auto' },
      space: {
        active: scope.space,
        business: business ? { id: business._id.toHexString(), name: business.name } : null,
      },
      onboarding: onboardingDto(profile?.onboarding),
      assistant: assistantOf(ws),
      waitlist: profile?.waitlist ?? [],
      businessOpen: isBusinessOpen(),
    };
  }

  @Post('waitlist')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ask to hear when something launches (e.g. Captain Jack)' })
  @ApiBody({ type: JoinWaitlistDto })
  @ApiNoContentResponse()
  @ApiUnprocessableEntityResponse({ type: ApiErrorResponse })
  async joinWaitlist(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<void> {
    const input = parseInput(waitlistInput, body ?? {});
    await this.workspaces.ensureForUser(user);
    await this.profiles.updateOne({ userId: user.id }, { $addToSet: { waitlist: input.list } });
  }

  @Patch('assistant')
  @ApiOperation({ summary: 'Rename the Personal assistant (an empty name goes back to Jack)' })
  @ApiBody({ type: UpdateAssistantDto })
  @ApiOkResponse({ type: MeAssistantDto })
  @ApiUnprocessableEntityResponse({ type: ApiErrorResponse })
  async renameAssistant(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<MeAssistantDto> {
    const input = parseInput(assistantInput, body ?? {});
    const name = cleanAssistantName(input.name);
    const ws = await this.workspaces.setAssistantName(user, name);
    return assistantOf(ws);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Change defaults such as the text model used for new messages' })
  @ApiBody({ type: UpdatePreferencesDto })
  @ApiOkResponse({ type: MePreferencesDto })
  @ApiForbiddenResponse({ type: ApiErrorResponse, description: '`upgrade_required` for a Pro model' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorResponse })
  async updatePreferences(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ): Promise<MePreferencesDto> {
    const input = parseInput(preferencesInput, body ?? {});
    const ws = await this.workspaces.ensureForUser(user);
    if (input.textModel !== undefined) await this.models.assertSelectable(input.textModel, ws.plan);
    const profile = await this.profiles
      .findOneAndUpdate({ userId: user.id }, { $set: input }, { new: true, projection: { textModel: 1 } })
      .lean();
    return { textModel: profile?.textModel ?? 'auto' };
  }

  @Patch('onboarding')
  @ApiOperation({
    summary: 'Save sign-up answers: Personal or Business, and what Jack should help with first',
  })
  @ApiBody({ type: UpdateOnboardingDto })
  @ApiOkResponse({ type: MeOnboardingDto })
  @ApiUnprocessableEntityResponse({ type: ApiErrorResponse })
  async updateOnboarding(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<MeOnboardingDto> {
    const input = parseInput(onboardingInput, body ?? {});
    await this.workspaces.ensureForUser(user);
    const set: Record<string, string> = {};
    if (input.use) set['onboarding.use'] = input.use;
    if (input.goals) set['onboarding.goals'] = [...new Set(input.goals)].join(GOAL_SEP);
    if (input.note !== undefined) set['onboarding.note'] = input.note;
    const profile = await this.profiles
      .findOneAndUpdate({ userId: user.id }, { $set: set }, { new: true, projection: { onboarding: 1 } })
      .lean();
    return onboardingDto(profile?.onboarding);
  }
}
