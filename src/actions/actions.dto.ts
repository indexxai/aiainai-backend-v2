import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JACK_ACTION_KINDS } from '../database/schemas/jack-action.schema.js';

export class DetailDto {
  @ApiProperty({ example: 'Pay' }) label!: string;
  @ApiProperty({ example: 'PKR 98,400 to Skyline Air' }) value!: string;
}

export class LimitUseDto {
  @ApiProperty({ example: 'Per purchase' }) label!: string;
  @ApiProperty() used!: number;
  @ApiProperty() limit!: number;
}

/** Something Jack wants to do that waits for your OK (pay, send an email, add an event). */
export class JackActionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: JACK_ACTION_KINDS }) kind!: (typeof JACK_ACTION_KINDS)[number];
  @ApiProperty({ example: 'Pay for 2 flight seats' }) title!: string;
  @ApiProperty({ enum: ['pending', 'done', 'failed', 'rejected', 'cancelled'] })
  status!: 'pending' | 'done' | 'failed' | 'rejected' | 'cancelled';
  @ApiProperty({ enum: ['personal', 'business'] }) space!: 'personal' | 'business';
  @ApiProperty({ type: [DetailDto], description: 'Exactly what will happen' }) details!: DetailDto[];
  @ApiPropertyOptional({ description: 'Purchase amount' }) amount?: number;
  @ApiPropertyOptional() currency?: string;
  @ApiPropertyOptional({ type: [LimitUseDto], description: 'Purchase: how it fits your limits' })
  limits?: LimitUseDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it can’t be approved now (limit, blocked site)',
  })
  blocked!: string | null;
  @ApiPropertyOptional({ description: 'Email: the text, editable before sending' }) body?: string;
  @ApiProperty({ type: String, nullable: true }) chatId!: string | null;
  @ApiProperty({ type: String, nullable: true }) browserTaskId!: string | null;
  @ApiProperty({ description: 'What happened, once decided' }) result!: string;
  @ApiProperty() note!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) decidedAt!: string | null;
}

export class ApproveActionDto {
  @ApiPropertyOptional({ description: 'Email: the edited text to send instead' }) body?: string;
}

export class RejectActionDto {
  @ApiPropertyOptional({ maxLength: 300 }) note?: string;
}
