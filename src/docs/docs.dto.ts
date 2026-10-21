import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DOC_LENGTHS,
  DOC_STATUS,
  DOC_TONES,
  DOC_TYPES,
  LINK_ACCESS,
} from '../database/schemas/document.schema.js';
import { VERSION_KINDS } from '../database/schemas/doc-version.schema.js';

export class SectionDto {
  @ApiProperty({ maxLength: 120 }) heading!: string;
  @ApiProperty({ maxLength: 120, description: 'Where the content comes from, e.g. "From your brief"' })
  note!: string;
}

export class OutlineRequestDto {
  @ApiProperty({ maxLength: 4000 }) brief!: string;
  @ApiProperty({ enum: DOC_TYPES }) type!: (typeof DOC_TYPES)[number];
  @ApiPropertyOptional({ description: 'A model key or "auto"' }) model?: string;
  @ApiPropertyOptional({ description: 'Put the document in this project' })
  projectId?: string;
}

export class EstimateDto {
  @ApiProperty() credits!: number;
  @ApiProperty() words!: number;
}

export class EstimatesDto {
  @ApiProperty({ type: EstimateDto }) short!: EstimateDto;
  @ApiProperty({ type: EstimateDto }) medium!: EstimateDto;
  @ApiProperty({ type: EstimateDto }) long!: EstimateDto;
}

export class OutlineDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: [SectionDto] }) sections!: SectionDto[];
  @ApiProperty({ description: 'Credits the outline used' }) credits!: number;
}

export class EstimateRequestDto {
  @ApiPropertyOptional() model?: string;
  @ApiPropertyOptional() sections?: number;
}

export class CreateDocDto {
  @ApiProperty({ maxLength: 200 }) title!: string;
  @ApiProperty({ enum: DOC_TYPES }) type!: (typeof DOC_TYPES)[number];
  @ApiPropertyOptional({ maxLength: 4000 }) brief?: string;
  @ApiProperty({ type: [SectionDto], description: 'Empty for a blank document' }) sections!: SectionDto[];
  @ApiPropertyOptional({ enum: DOC_LENGTHS }) length?: (typeof DOC_LENGTHS)[number];
  @ApiPropertyOptional({ enum: DOC_TONES }) tone?: (typeof DOC_TONES)[number];
  @ApiPropertyOptional({ description: 'A model key or "auto"' }) model?: string;
  @ApiPropertyOptional({ description: 'Put the document in this project' })
  projectId?: string;
}

export class UpdateDocDto {
  @ApiPropertyOptional({ maxLength: 200 }) title?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Editor JSON' })
  content?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Plain text of the content (search, word count)' }) text?: string;
  @ApiPropertyOptional({
    maxLength: 80,
    description: 'Set when this save applies an accepted AI change (e.g. "Made shorter"): a version is kept.',
  })
  aiChange?: string;
}

export class DocErrorDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class DocSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DOC_TYPES }) type!: (typeof DOC_TYPES)[number];
  @ApiProperty({ enum: DOC_STATUS }) status!: (typeof DOC_STATUS)[number];
  @ApiProperty() wordCount!: number;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'People it’s shared with (mine only)' }) sharedWith?: number;
  @ApiPropertyOptional({ enum: LINK_ACCESS }) linkAccess?: (typeof LINK_ACCESS)[number];
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Someone else’s document shared with me: who shared it (null for mine)',
  })
  sharedBy?: string | null;
}

export class DocProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class DocDto extends DocSummaryDto {
  @ApiProperty({ type: DocProjectDto, nullable: true, description: 'The project it is in' })
  project!: DocProjectDto | null;
  @ApiProperty() brief!: string;
  @ApiProperty({ type: [SectionDto] }) sections!: SectionDto[];
  @ApiProperty({ enum: DOC_LENGTHS }) length!: (typeof DOC_LENGTHS)[number];
  @ApiProperty({ enum: DOC_TONES }) tone!: (typeof DOC_TONES)[number];
  @ApiProperty({ description: 'The AI draft (Markdown)' }) markdown!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Editor JSON once edited',
  })
  content!: Record<string, unknown> | null;
  @ApiProperty({ description: 'Model requested: a key or "auto"' }) requestedModel!: string;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) modelName!: string | null;
  @ApiProperty() auto!: boolean;
  @ApiProperty({ description: 'Credits writing has cost so far' }) credits!: number;
  @ApiProperty({ description: 'Sections fully written' }) sectionsDone!: number;
  @ApiProperty({ type: DocErrorDto, nullable: true }) error!: DocErrorDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ enum: ['edit', 'view'], description: 'view: shared with you, read-only' })
  access!: 'edit' | 'view';
  @ApiProperty({ enum: LINK_ACCESS }) declare linkAccess: (typeof LINK_ACCESS)[number];
  @ApiProperty({ description: 'People invited (owners only; 0 for viewers)' }) declare sharedWith: number;
}

export class DocListDto {
  @ApiProperty({ type: [DocSummaryDto] }) items!: DocSummaryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

/* Writing stream: `ready` {doc} → `model` → `delta` {text}… → `done` | `error` {doc} */
export class DocStreamDocEvent {
  @ApiProperty({ type: DocDto }) doc!: DocDto;
}

/* ── AI editing ─────────────────────────────────────────────────────────────── */

export class EditRequestDto {
  @ApiProperty({ maxLength: 8000, description: 'The selected text (Markdown)' }) text!: string;
  @ApiPropertyOptional({ enum: ['shorter', 'formal', 'simpler', 'grammar', 'translate'] })
  action?: 'shorter' | 'formal' | 'simpler' | 'grammar' | 'translate';
  @ApiPropertyOptional({ maxLength: 500, description: 'Free-form instruction (instead of an action)' })
  instruction?: string;
  @ApiPropertyOptional({ description: 'Target language for translate' }) language?: string;
  @ApiPropertyOptional({ maxLength: 1500, description: 'Nearby text, for context' }) context?: string;
  @ApiPropertyOptional({ description: 'A model key or "auto"' }) model?: string;
}

export class EditResultDto {
  @ApiProperty({ description: 'The suggested replacement (Markdown)' }) text!: string;
  @ApiProperty() credits!: number;
  @ApiProperty() model!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty() auto!: boolean;
}

export class AssistantTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
  @ApiProperty() content!: string;
}

export class AssistantRequestDto {
  @ApiProperty({ maxLength: 2000 }) message!: string;
  @ApiProperty({ description: 'The editor’s current Markdown' }) markdown!: string;
  @ApiPropertyOptional({ type: [AssistantTurnDto] }) history?: AssistantTurnDto[];
  @ApiPropertyOptional({ description: 'A model key or "auto"' }) model?: string;
}

export class InsertSuggestionDto {
  @ApiProperty() heading!: string;
  @ApiProperty({ description: 'Starts with "## heading"' }) markdown!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Add after this section; null = at the end' })
  after!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Rewrite of this existing section (instead of adding)',
  })
  replaces!: string | null;
}

export class AssistantReplyDto {
  @ApiProperty() reply!: string;
  @ApiProperty({ type: InsertSuggestionDto, nullable: true }) insert!: InsertSuggestionDto | null;
  @ApiProperty({ description: 'The document was too long to read in full' }) truncated!: boolean;
  @ApiProperty() credits!: number;
  @ApiProperty() model!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty() auto!: boolean;
}

/* ── Sharing ────────────────────────────────────────────────────────────────── */

export class InviteDto {
  @ApiProperty() email!: string;
  @ApiProperty() invitedAt!: string;
  @ApiProperty({ enum: ['view'] }) role!: 'view';
}

export class ShareDto {
  @ApiProperty({ enum: LINK_ACCESS }) declare linkAccess: (typeof LINK_ACCESS)[number];
  @ApiProperty({ type: String, nullable: true, description: 'Public link (when on)' }) url!: string | null;
  @ApiProperty({ type: [InviteDto] }) invites!: InviteDto[];
}

export class UpdateShareDto {
  @ApiPropertyOptional({ enum: LINK_ACCESS }) linkAccess?: (typeof LINK_ACCESS)[number];
  @ApiPropertyOptional({ description: 'Make a new link; the old one stops working' }) resetLink?: boolean;
}

export class InviteRequestDto {
  @ApiProperty({ type: [String], maxItems: 10 }) emails!: string[];
  @ApiPropertyOptional({ maxLength: 500 }) message?: string;
}

export class PublicDocDto {
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DOC_TYPES }) type!: (typeof DOC_TYPES)[number];
  @ApiProperty() markdown!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  content!: Record<string, unknown> | null;
  @ApiProperty() wordCount!: number;
  @ApiProperty() updatedAt!: string;
}

export class VersionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: VERSION_KINDS }) kind!: (typeof VERSION_KINDS)[number];
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['you', 'assistant', 'teammate'] }) by!: 'you' | 'assistant' | 'teammate';
  @ApiProperty() named!: boolean;
  @ApiProperty() wordCount!: number;
  @ApiProperty() createdAt!: string;
}

export class VersionListDto {
  @ApiProperty({ type: [VersionDto] }) versions!: VersionDto[];
  @ApiProperty({ description: 'Days of history this plan keeps' }) historyDays!: number;
}

export class VersionDetailDto extends VersionDto {
  @ApiProperty() title!: string;
  @ApiProperty() markdown!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  content!: Record<string, unknown> | null;
}

export class NameVersionDto {
  @ApiPropertyOptional({ maxLength: 120, description: 'Defaults to "Version N"' }) name?: string;
}
