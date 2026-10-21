import { ApiProperty } from '@nestjs/swagger';

export class TranscriptDto {
  @ApiProperty({ example: 'Find me three good hotels in Dubai for next weekend.' }) text!: string;
  @ApiProperty({ description: 'Credits charged (1 per started minute)', example: 1 }) credits!: number;
}
