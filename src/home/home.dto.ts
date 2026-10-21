import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HomeItemDto {
  @ApiProperty({ enum: ['action', 'doc', 'image'] })
  kind!: 'action' | 'doc' | 'image';
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Who or what, in one line' }) detail!: string;
  @ApiProperty({ description: 'Where tapping it goes in the web app' }) href!: string;
  @ApiPropertyOptional({ description: '0–100 while running' }) progress?: number;
}

export class HomeSuggestionDto {
  @ApiProperty() icon!: string;
  @ApiProperty() text!: string;
}

export class HomeDto {
  @ApiProperty({ enum: ['personal', 'business'] }) space!: 'personal' | 'business';
  @ApiProperty({ type: [HomeItemDto], description: 'Waiting for the person (newest first, up to 4)' })
  needsYou!: HomeItemDto[];
  @ApiProperty() needsYouCount!: number;
  @ApiProperty({ type: [HomeItemDto], description: 'Running now (up to 4)' }) inProgress!: HomeItemDto[];
  @ApiProperty() inProgressCount!: number;
  @ApiProperty({ type: [HomeSuggestionDto] }) suggestions!: HomeSuggestionDto[];
  @ApiProperty({ description: 'How many things Jack remembers in this space' }) memoryCount!: number;
  @ApiProperty({ type: [String], description: 'Apps connected in this space', example: ['Gmail'] })
  apps!: string[];
}
