import { JACK_TOOLS, type JackTool } from '../database/schemas/chat.schema.js';
import { JackActionDto } from '../actions/actions.dto.js';
import { AttachmentDto } from '../files/files.dto.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Start of the latest message' }) preview!: string;
  @ApiProperty() pinned!: boolean;
  @ApiProperty() messageCount!: number;
  @ApiProperty() lastMessageAt!: string;
  @ApiProperty({ description: 'Model for the next message: a model key or "auto"' }) model!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The project it is in' }) projectId!:
    string | null;
  @ApiProperty({ type: [String], description: 'Connected apps (and "browser") Jack won’t use in this chat' })
  appsOff!: string[];
}

export class ChatProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class ChatListDto {
  @ApiProperty({ type: [ChatSummaryDto] }) items!: ChatSummaryDto[];
  @ApiProperty({ type: String, nullable: true, description: 'Pass as `cursor` for the next page' })
  nextCursor!: string | null;
}

export class MessageErrorDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class PlanStepDto {
  @ApiProperty({ enum: JACK_TOOLS })
  tool!: JackTool;
  @ApiProperty({ example: 'Trip checklist — Dubai' }) title!: string;
  @ApiProperty({
    enum: ['running', 'waiting', 'done', 'failed', 'skipped'],
    description: 'Live: running · waiting (needs your OK) · done · failed · skipped (could not start)',
  })
  status!: 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
  @ApiProperty({ example: 'Writing in AI Docs' }) detail!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Where it opens in the web app' })
  href!: string | null;
  @ApiPropertyOptional({
    type: JackActionDto,
    nullable: true,
    description: 'Waiting for your OK (approve here)',
  })
  action?: JackActionDto | null;
  @ApiPropertyOptional({ description: 'What a finished step found (Jack’s browser), in Markdown' })
  result?: string;
}

export class LearnedDto {
  @ApiProperty({ description: 'Memory id (forget with DELETE /api/memory/{id})' }) id!: string;
  @ApiProperty({ example: 'Prefers morning flights' }) text!: string;
}

export class MessageDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
  @ApiProperty() content!: string;
  @ApiProperty({ enum: ['complete', 'streaming', 'stopped', 'failed'] })
  status!: 'complete' | 'streaming' | 'stopped' | 'failed';
  @ApiProperty({ type: String, nullable: true, description: 'Model that answered' }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) modelName!: string | null;
  @ApiProperty({ description: 'Auto chose the model' }) auto!: boolean;
  @ApiProperty({ description: 'Credits charged for this answer' }) credits!: number;
  @ApiProperty({ type: String, enum: ['up', 'down'], nullable: true }) feedback!: 'up' | 'down' | null;
  @ApiProperty({ type: MessageErrorDto, nullable: true }) error!: MessageErrorDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [AttachmentDto], description: 'Files attached to a person’s message' })
  attachments!: AttachmentDto[];
  @ApiProperty({ type: [PlanStepDto], description: 'What Jack started with his tools for this answer' })
  plan!: PlanStepDto[];
  @ApiProperty({
    type: [LearnedDto],
    description: 'What Jack remembered from the message before this answer',
  })
  learned!: LearnedDto[];
}

export class ChatDetailDto {
  @ApiProperty({ type: ChatSummaryDto }) chat!: ChatSummaryDto;
  @ApiProperty({ type: ChatProjectDto, nullable: true, description: 'The project it is in' })
  project!: ChatProjectDto | null;
  @ApiProperty({ type: [MessageDto], description: 'Oldest first' }) messages!: MessageDto[];
}

export class CreateChatDto {
  @ApiPropertyOptional({ example: 'auto' }) model?: string;
  @ApiPropertyOptional({ description: 'Start the chat in this project' }) projectId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Apps Jack won’t use in this chat' })
  appsOff?: string[];
}

export class UpdateChatDto {
  @ApiPropertyOptional({ maxLength: 200 }) title?: string;
  @ApiPropertyOptional() pinned?: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Apps Jack won’t use in this chat' })
  appsOff?: string[];
}

export class SendMessageDto {
  @ApiProperty({ maxLength: 32000, description: 'Can be empty when files are attached' }) text!: string;
  @ApiPropertyOptional({ type: [String], description: 'Uploaded file ids to attach (up to 5)' })
  fileIds?: string[];
  @ApiPropertyOptional({ description: 'A model key or "auto"; defaults to the chat’s model' }) model?: string;
}

export class RunOptionsDto {
  @ApiPropertyOptional({ description: 'A model key or "auto"; defaults to the original request' })
  model?: string;
}

export class FeedbackDto {
  @ApiProperty({ type: String, enum: ['up', 'down'], nullable: true }) value!: 'up' | 'down' | null;
}

/* ── Streaming events (text/event-stream). Each SSE `event:` name carries this JSON `data`. ── */

/** `ready`: the messages were saved; the answer starts next. */
export class StreamReadyEvent {
  @ApiPropertyOptional({
    type: MessageDto,
    description: 'The person’s new message (not sent for regenerate/continue)',
  })
  userMessage?: MessageDto;
  @ApiProperty({ type: MessageDto, description: 'The answer being written (status "streaming")' })
  message!: MessageDto;
  @ApiProperty({ type: ChatSummaryDto }) chat!: ChatSummaryDto;
}

/** `model`: which model is answering. */
export class StreamModelEvent {
  @ApiProperty() model!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty() auto!: boolean;
  @ApiProperty({ description: 'Credits this answer costs if it completes' }) credits!: number;
}

/** `plan`: what Jack started with his tools, before the answer text. */
export class StreamPlanEvent {
  @ApiProperty() messageId!: string;
  @ApiProperty({ type: [PlanStepDto] }) steps!: PlanStepDto[];
}

/** `delta`: more answer text. */
export class StreamDeltaEvent {
  @ApiProperty() text!: string;
}

/** `done` (finished or stopped) and `error` (failed or not sent): the saved answer. */
export class StreamEndEvent {
  @ApiProperty({ type: MessageDto }) message!: MessageDto;
  @ApiProperty({ type: ChatSummaryDto }) chat!: ChatSummaryDto;
}

export class StopResultDto {
  @ApiProperty({ description: 'True when an answer or document was being written and is now stopping' })
  stopped!: boolean;
}
