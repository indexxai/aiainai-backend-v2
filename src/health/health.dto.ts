import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthCheckDto {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional({ description: 'Round-trip time in milliseconds' }) ms?: number;
  @ApiPropertyOptional({ description: 'Generic reason when not ok (details are only in server logs)' })
  error?: string;
}

export class HealthReportDto {
  @ApiProperty({ description: 'True when every dependency check passed' }) ok!: boolean;
  @ApiProperty({ example: 'dev' }) version!: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: '#/components/schemas/HealthCheckDto' } })
  checks!: Record<string, HealthCheckDto>;
}
