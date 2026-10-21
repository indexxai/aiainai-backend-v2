import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IMAGE_ITEM_STATUS,
  IMAGE_KINDS,
  IMAGE_STATUS,
  IMAGE_STYLES,
  REFERENCE_USES,
} from '../database/schemas/image.schema.js';
import { IMAGE_RATIOS } from '../models/providers.js';

export class ReferenceInputDto {
  @ApiProperty({ description: 'From POST /api/images/references' }) id!: string;
  @ApiProperty({ enum: REFERENCE_USES }) use!: (typeof REFERENCE_USES)[number];
}

export class CreateImagesDto {
  @ApiProperty({ maxLength: 1000 }) prompt!: string;
  @ApiPropertyOptional({ description: 'An image model key or "auto"' }) model?: string;
  @ApiProperty({ enum: IMAGE_RATIOS }) ratio!: (typeof IMAGE_RATIOS)[number];
  @ApiProperty({ enum: [1, 2, 4] }) count!: 1 | 2 | 4;
  @ApiPropertyOptional() hd?: boolean;
  @ApiPropertyOptional({ enum: IMAGE_STYLES }) style?: (typeof IMAGE_STYLES)[number];
  @ApiPropertyOptional({ maxLength: 300, description: 'Things to leave out' }) negative?: string;
  @ApiPropertyOptional({ type: ReferenceInputDto }) reference?: ReferenceInputDto;
}

export class ReferenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

export class ImageIndexDto {
  @ApiProperty({ description: 'Which image of the batch' }) index!: number;
}

export class EditImageDto {
  @ApiProperty() index!: number;
  @ApiProperty({ maxLength: 1000, description: 'What should be in the selected area' }) prompt!: string;
  @ApiProperty({
    description: 'PNG as base64 (or a data: URL): white or opaque where the image should change',
  })
  mask!: string;
  @ApiPropertyOptional({ description: 'An image model key or "auto"' }) model?: string;
}

export class ImprovePromptDto {
  @ApiProperty({ maxLength: 1000 }) prompt!: string;
  @ApiPropertyOptional({ enum: IMAGE_STYLES }) style?: (typeof IMAGE_STYLES)[number];
}

export class ImprovedPromptDto {
  @ApiProperty() prompt!: string;
}

export class EditModelDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() credits!: number;
}

export class ImageCapabilitiesDto {
  @ApiProperty({
    type: EditModelDto,
    nullable: true,
    description: 'The model Auto uses for edits, variations and references on this plan (null: none)',
  })
  editModel!: EditModelDto | null;
  @ApiProperty({ description: 'Reference images can be used' }) reference!: boolean;
  @ApiProperty() variations!: boolean;
  @ApiProperty() edit!: boolean;
  @ApiProperty({ description: 'The upscaler is set up' }) upscale!: boolean;
  @ApiProperty({ description: 'The background remover is set up' }) removeBackground!: boolean;
  @ApiProperty({ enum: ['pro'] }) toolsPlan!: 'pro';
  @ApiProperty({ description: 'Upscale and Remove background are on this plan' }) toolsIncluded!: boolean;
  @ApiProperty() upscaleCredits!: number;
  @ApiProperty() removeBackgroundCredits!: number;
  @ApiProperty() variationCount!: number;
}

export class ImageSourceDto {
  @ApiProperty() id!: string;
  @ApiProperty() index!: number;
}

export class ImageReferenceDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: REFERENCE_USES }) use!: (typeof REFERENCE_USES)[number];
}

export class ImageItemDto {
  @ApiProperty() index!: number;
  @ApiProperty({ enum: IMAGE_ITEM_STATUS }) status!: (typeof IMAGE_ITEM_STATUS)[number];
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: String, nullable: true, description: 'Full image (PNG)' }) url!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Small preview (WebP)' }) thumbUrl!:
    string | null;
}

export class ImageErrorDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class ImageGenerationDto {
  @ApiProperty() id!: string;
  @ApiProperty() prompt!: string;
  @ApiProperty() title!: string;
  @ApiProperty() negative!: string;
  @ApiProperty() requestedModel!: string;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) modelName!: string | null;
  @ApiProperty() auto!: boolean;
  @ApiProperty({ enum: IMAGE_RATIOS }) ratio!: (typeof IMAGE_RATIOS)[number];
  @ApiProperty() count!: number;
  @ApiProperty() hd!: boolean;
  @ApiProperty({ enum: IMAGE_STYLES }) style!: (typeof IMAGE_STYLES)[number];
  @ApiProperty({ enum: IMAGE_STATUS }) status!: (typeof IMAGE_STATUS)[number];
  @ApiProperty({ type: [ImageItemDto] }) images!: ImageItemDto[];
  @ApiProperty({ description: 'Credits charged' }) credits!: number;
  @ApiProperty({ enum: IMAGE_KINDS }) kind!: (typeof IMAGE_KINDS)[number];
  @ApiProperty({ type: ImageSourceDto, nullable: true, description: 'The image this was made from' })
  source!: ImageSourceDto | null;
  @ApiProperty({ type: ImageReferenceDto, nullable: true }) reference!: ImageReferenceDto | null;
  @ApiProperty({ type: ImageErrorDto, nullable: true }) error!: ImageErrorDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ImageListDto {
  @ApiProperty({ type: [ImageGenerationDto] }) items!: ImageGenerationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
