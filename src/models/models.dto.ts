import { ApiProperty } from '@nestjs/swagger';

export class ModelOptionDto {
  @ApiProperty({ example: 'claude-sonnet' }) key!: string;
  @ApiProperty({ example: 'Claude Sonnet' }) name!: string;
  @ApiProperty({ example: 'Anthropic' }) provider!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ description: 'Credits per message (text) or per image' }) credits!: number;
  @ApiProperty({ description: 'Not on this workspace’s plan; show the upgrade badge' }) locked!: boolean;
  @ApiProperty({ enum: ['free', 'pro'], description: 'Cheapest plan that includes this model' })
  requiredPlan!: 'free' | 'pro';
}

export class AutoOptionDto {
  @ApiProperty({ example: 'auto' }) key!: string;
  @ApiProperty({ example: 'Auto' }) name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
}

export class ModelMenuDto {
  @ApiProperty({ enum: ['text', 'image'] }) kind!: 'text' | 'image';
  @ApiProperty({ type: AutoOptionDto, nullable: true, description: 'Offered for text models' })
  auto!: AutoOptionDto | null;
  @ApiProperty({ type: [ModelOptionDto], description: 'Grouped by provider in the menu, in this order' })
  models!: ModelOptionDto[];
  @ApiProperty({ description: 'The person’s default for new messages: a model key or "auto"' })
  selected!: string;
  @ApiProperty({ description: 'Answers come from the stand-in model (no provider keys yet)' })
  demo!: boolean;
}
