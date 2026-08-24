import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { HealthResponseDto } from './health-response.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Report application and dependency (Postgres/Redis) liveness' })
  @ApiResponse({ status: 200, description: 'All dependencies reachable.', type: HealthResponseDto })
  @ApiResponse({
    status: 503,
    description: 'At least one dependency is unreachable.',
    type: HealthResponseDto,
  })
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponseDto> {
    const result = await this.healthService.check();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
