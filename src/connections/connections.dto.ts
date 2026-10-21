import { ApiProperty } from '@nestjs/swagger';
import { ACCESS_LEVELS } from '../database/schemas/connection.schema.js';

export class ConnectionDto {
  @ApiProperty({ example: 'gmail' }) id!: string;
  @ApiProperty({ example: 'Gmail' }) name!: string;
  @ApiProperty() icon!: string;
  @ApiProperty({ description: 'What Jack does with it' }) what!: string;
  @ApiProperty({ description: 'Can be connected now' }) available!: boolean;
  @ApiProperty({ enum: ['connected', 'pending', 'failed', 'not_connected', 'coming'] })
  status!: 'connected' | 'pending' | 'failed' | 'not_connected' | 'coming';
  @ApiProperty({ enum: ACCESS_LEVELS }) level!: (typeof ACCESS_LEVELS)[number];
  @ApiProperty({ enum: ACCESS_LEVELS, isArray: true, description: 'The levels this app can be set to' })
  levels!: (typeof ACCESS_LEVELS)[number][];
  @ApiProperty({ type: String, nullable: true, description: 'The connected account, e.g. an email address' })
  account!: string | null;
  @ApiProperty({ type: String, nullable: true }) connectedAt!: string | null;
}

export class ConnectionsDto {
  @ApiProperty({ description: 'Stand-in connector (no connector key on the server): sample data' })
  demo!: boolean;
  @ApiProperty({
    enum: ['live', 'sample', 'off'],
    description: 'Jack’s browser: hosted, sample sites, or off',
  })
  browser!: 'live' | 'sample' | 'off';
  @ApiProperty({ type: [ConnectionDto] }) apps!: ConnectionDto[];
}

export class ConnectResultDto {
  @ApiProperty({ type: String, nullable: true, description: 'Send the person here to sign in to the app' })
  redirectUrl!: string | null;
  @ApiProperty({ type: ConnectionsDto }) connections!: ConnectionsDto;
}

export class SetLevelDto {
  @ApiProperty({ enum: ACCESS_LEVELS }) level!: (typeof ACCESS_LEVELS)[number];
}
