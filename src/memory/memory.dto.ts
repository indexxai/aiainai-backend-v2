import { ApiProperty } from '@nestjs/swagger';
import { MEMORY_GROUPS } from '../database/schemas/memory.schema.js';

export class MemoryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prefers morning flights and aisle seats' }) text!: string;
  @ApiProperty({ enum: MEMORY_GROUPS }) group!: (typeof MEMORY_GROUPS)[number];
  @ApiProperty({
    enum: ['you', 'jack'],
    description: 'you: added by the person · jack: learned in a conversation',
  })
  source!: 'you' | 'jack';
  @ApiProperty({ type: String, nullable: true, description: 'The conversation it was learned in' })
  chatId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class MemoryListDto {
  @ApiProperty({ description: 'Jack may learn new things in this space' }) enabled!: boolean;
  @ApiProperty({ type: [MemoryDto], description: 'Newest first' }) items!: MemoryDto[];
}

export class AddMemoryDto {
  @ApiProperty({ maxLength: 300 }) text!: string;
  @ApiProperty({ enum: MEMORY_GROUPS }) group!: (typeof MEMORY_GROUPS)[number];
}

export class UpdateMemoryDto {
  @ApiProperty({ maxLength: 300, required: false }) text?: string;
  @ApiProperty({ enum: MEMORY_GROUPS, required: false }) group?: (typeof MEMORY_GROUPS)[number];
}

export class MemorySettingsDto {
  @ApiProperty() enabled!: boolean;
}
