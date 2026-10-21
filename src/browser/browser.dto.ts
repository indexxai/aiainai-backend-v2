import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BROWSER_STATUS } from '../database/schemas/browser-task.schema.js';
import { JackActionDto } from '../actions/actions.dto.js';

export class BrowserStepDto {
  @ApiProperty() at!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ enum: ['done', 'working', 'needs_you', 'failed'] }) state!:
    'done' | 'working' | 'needs_you' | 'failed';
}

export class ViewFieldDto {
  @ApiProperty() label!: string;
  @ApiProperty() value!: string;
  @ApiPropertyOptional() active?: boolean;
}

export class BrowserViewDto {
  @ApiProperty() url!: string;
  @ApiProperty() site!: string;
  @ApiProperty() heading!: string;
  @ApiProperty({ type: [ViewFieldDto] }) fields!: ViewFieldDto[];
  @ApiPropertyOptional() button?: string;
  @ApiPropertyOptional() note?: string;
}

export class BrowserTaskDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() goal!: string;
  @ApiProperty({ enum: BROWSER_STATUS }) status!: (typeof BROWSER_STATUS)[number];
  @ApiProperty({ type: [BrowserStepDto] }) steps!: BrowserStepDto[];
  @ApiProperty({ type: BrowserViewDto, nullable: true, description: 'Sample mode: a drawing of the page' })
  view!: BrowserViewDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'Live view to embed (hosted browser)' })
  liveUrl!: string | null;
  @ApiProperty({ description: 'No browser service key: sample steps and pages' }) sample!: boolean;
  @ApiProperty({ type: String, nullable: true }) chatId!: string | null;
  @ApiProperty({ type: JackActionDto, nullable: true, description: 'The purchase waiting for your OK' })
  action!: JackActionDto | null;
  @ApiProperty() summary!: string;
  @ApiProperty() createdAt!: string;
}
