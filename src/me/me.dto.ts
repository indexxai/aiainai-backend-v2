import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MeUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiPropertyOptional({ nullable: true, type: String }) image?: string | null;
}

export class MeWorkspaceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['free', 'pro'] }) plan!: 'free' | 'pro';
  @ApiProperty({ description: 'When plan credits reset' }) periodEnd!: string;
}

export class MeCreditsDto {
  @ApiProperty({ description: 'Credits that can be spent now (plan + top-up)' }) spendable!: number;
  @ApiProperty() plan!: number;
  @ApiProperty() topup!: number;
  @ApiProperty({ description: 'Reserved by running jobs' }) held!: number;
  @ApiProperty({ description: 'Plan credits granted each period' }) monthly!: number;
}

export class MePreferencesDto {
  @ApiProperty({ description: 'Default text model: a model key or "auto"', example: 'auto' })
  textModel!: string;
}

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    description: 'A model key from GET /api/models, or "auto"',
    example: 'claude-sonnet',
  })
  textModel?: string;
}

export class MeBusinessDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class MeSpaceDto {
  @ApiProperty({ enum: ['personal', 'business'], description: 'The space this request was served from' })
  active!: 'personal' | 'business';
  @ApiPropertyOptional({ type: MeBusinessDto, nullable: true, description: 'Null until set up' })
  business!: MeBusinessDto | null;
}

export const ONBOARDING_USES = ['personal', 'business'] as const;
export type OnboardingUse = (typeof ONBOARDING_USES)[number];

/** Most first goals one person can pick on "What do you want Jack to help with first?". */
export const MAX_GOALS = 12;

export class MeOnboardingDto {
  @ApiProperty({ description: 'True for a new account that has not yet picked Personal or Business' })
  askUse!: boolean;
  @ApiProperty({ enum: ONBOARDING_USES, nullable: true, type: String, description: 'What they picked' })
  use!: OnboardingUse | null;
  @ApiProperty({ type: [String], description: 'What they want Jack to help with first (labels they picked)' })
  goals!: string[];
  @ApiProperty({ type: String, description: 'The same, in their own words (empty if none)' })
  note!: string;
}

export class UpdateOnboardingDto {
  @ApiProperty({ enum: ONBOARDING_USES, required: false }) use?: OnboardingUse;
  @ApiProperty({ type: [String], required: false, maxItems: MAX_GOALS }) goals?: string[];
  @ApiProperty({ type: String, required: false, maxLength: 300 }) note?: string;
}

export class MeAssistantDto {
  @ApiProperty({ example: 'Jack', description: 'What the Personal assistant is called in sentences' })
  name!: string;
  @ApiProperty({ example: 'Jack of all trades', description: 'His title where he is named on his own' })
  title!: string;
  @ApiProperty({ description: 'True when the person picked the name' }) custom!: boolean;
}

export class UpdateAssistantDto {
  @ApiProperty({ maxLength: 20, description: 'The new name; empty (or "Jack") goes back to Jack' })
  name!: string;
}

export const WAITLISTS = ['captain-jack'] as const;

export class JoinWaitlistDto {
  @ApiProperty({ enum: WAITLISTS }) list!: (typeof WAITLISTS)[number];
}

export class MeDto {
  @ApiProperty({ type: MeUserDto }) user!: MeUserDto;
  @ApiProperty({ type: MeWorkspaceDto }) workspace!: MeWorkspaceDto;
  @ApiProperty({ type: MeCreditsDto }) credits!: MeCreditsDto;
  @ApiProperty({ type: MePreferencesDto }) preferences!: MePreferencesDto;
  @ApiProperty({ type: MeSpaceDto }) space!: MeSpaceDto;
  @ApiProperty({ type: MeOnboardingDto }) onboarding!: MeOnboardingDto;
  @ApiProperty({ type: MeAssistantDto, description: 'The Personal assistant and his name' })
  assistant!: MeAssistantDto;
  @ApiProperty({ type: [String], description: 'Launches the person asked to hear about' })
  waitlist!: string[];
  @ApiProperty({ description: 'False until the Business space (Captain Jack) launches' })
  businessOpen!: boolean;
}
