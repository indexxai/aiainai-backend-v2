import { ApiProperty } from '@nestjs/swagger';
import { JackActionDto } from '../actions/actions.dto.js';

export const ACTIVITY_KINDS = ['conversation', 'doc', 'image', 'action'] as const;

export class ActivityItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['personal', 'business'] }) space!: 'personal' | 'business';
  @ApiProperty({ enum: ACTIVITY_KINDS }) kind!: (typeof ACTIVITY_KINDS)[number];
  @ApiProperty({ enum: ['you', 'jack', 'team'] }) who!: 'you' | 'jack' | 'team';
  @ApiProperty({ example: 'Jack of all trades' }) whoName!: string;
  @ApiProperty({ description: 'Icon for the row (the kind of thing)' }) icon!: string;
  @ApiProperty({ example: 'made the document “Trip checklist — Dubai”' }) text!: string;
  @ApiProperty({ example: 'Personal · AI Docs · Ready' }) detail!: string;
  @ApiProperty({ type: String, nullable: true }) href!: string | null;
  @ApiProperty({ description: 'Waiting for the person (shows a Review button)' }) waiting!: boolean;
}

export class ComingUpDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['personal', 'business'] }) space!: 'personal' | 'business';
  @ApiProperty() icon!: string;
  @ApiProperty() title!: string;
  @ApiProperty() detail!: string;
  @ApiProperty({ type: String, nullable: true }) href!: string | null;
}

export class ActivityDto {
  @ApiProperty({ type: [ActivityItemDto], description: 'Newest first, the last 30 days' })
  items!: ActivityItemDto[];
  @ApiProperty({ type: [ComingUpDto] }) comingUp!: ComingUpDto[];
}

export class AllApprovalsDto {
  @ApiProperty({ type: [JackActionDto], description: 'What Jack wants to do (pay, send, add)' })
  jackPending!: JackActionDto[];
  @ApiProperty({ type: [JackActionDto] }) jackDecided!: JackActionDto[];
}
