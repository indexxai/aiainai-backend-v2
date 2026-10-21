import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChatSummaryDto } from '../chats/chats.dto.js';
import { FileDto } from '../files/files.dto.js';

export class ProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Dubai trip' }) name!: string;
  @ApiProperty({ description: 'What Jack should know in every chat of this project' }) instructions!: string;
  @ApiProperty() chatCount!: number;
  @ApiProperty() docCount!: number;
  @ApiProperty() fileCount!: number;
  @ApiProperty() updatedAt!: string;
}

export class ProjectDocDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: string;
  @ApiProperty() updatedAt!: string;
}

export class ProjectDetailDto {
  @ApiProperty({ type: ProjectDto }) project!: ProjectDto;
  @ApiProperty({ type: [ChatSummaryDto] }) chats!: ChatSummaryDto[];
  @ApiProperty({ type: [ProjectDocDto] }) docs!: ProjectDocDto[];
  @ApiProperty({ type: [FileDto] }) files!: FileDto[];
}

export class CreateProjectDto {
  @ApiProperty({ maxLength: 120 }) name!: string;
  @ApiPropertyOptional({ maxLength: 4000 }) instructions?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional({ maxLength: 120 }) name?: string;
  @ApiPropertyOptional({ maxLength: 4000 }) instructions?: string;
}

export class ProjectItemDto {
  @ApiProperty({ enum: ['chat', 'doc', 'file'] }) kind!: 'chat' | 'doc' | 'file';
  @ApiProperty() id!: string;
}
