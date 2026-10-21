import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UPLOAD_KINDS } from '../database/schemas/upload.schema.js';

export class FileDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Q3 report.pdf' }) name!: string;
  @ApiProperty({ enum: UPLOAD_KINDS }) kind!: (typeof UPLOAD_KINDS)[number];
  @ApiProperty() contentType!: string;
  @ApiProperty({ description: 'Size in bytes' }) bytes!: number;
  @ApiPropertyOptional() pages?: number;
  @ApiProperty({ description: 'Characters of text Jack can read' }) chars!: number;
  @ApiProperty({ description: 'The text was cut to fit' }) truncated!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Why Jack can’t read it, if so' }) note!:
    string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The chat it was attached in' }) chatId!:
    string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The project it belongs to' })
  projectId!: string | null;
  @ApiProperty({ description: 'Credits used to read it (images)' }) credits!: number;
  @ApiProperty() createdAt!: string;
}

export class FileListDto {
  @ApiProperty({ type: [FileDto] }) items!: FileDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

/** A file on a chat message (shown as a chip). */
export class AttachmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: UPLOAD_KINDS }) kind!: (typeof UPLOAD_KINDS)[number];
}
