import { ApiProperty } from '@nestjs/swagger';

export type DependencyStatus = 'up' | 'down';

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'degraded'] })
  status!: 'ok' | 'degraded';

  @ApiProperty({
    example: { postgres: 'up', redis: 'up' },
    description: 'Liveness of each external dependency this API depends on.',
  })
  dependencies!: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
  };
}
