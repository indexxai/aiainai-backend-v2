import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PROVIDERS } from '../models/models.logic.js';

export class ProviderDto {
  @ApiProperty({ enum: PROVIDERS }) id!: string;
  @ApiProperty({ example: 'DeepSeek' }) name!: string;
}

export class SpaceBusinessDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'indexx.ai' }) name!: string;
  @ApiPropertyOptional() website?: string;
  @ApiPropertyOptional({ description: 'What the business does, in the owner’s words' }) about?: string;
  @ApiProperty({ type: [String], description: 'What Jack should help with first' }) helpWith!: string[];
}

export class SpacePersonalDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class SpacesDto {
  @ApiProperty({ enum: ['personal', 'business'], description: 'The space this request was served from' })
  active!: 'personal' | 'business';
  @ApiProperty({ type: SpacePersonalDto }) personal!: SpacePersonalDto;
  @ApiPropertyOptional({ type: SpaceBusinessDto, nullable: true }) business!: SpaceBusinessDto | null;
  @ApiProperty({ type: [ProviderDto], description: 'The model makers behind Jack' })
  providers!: ProviderDto[];
}
