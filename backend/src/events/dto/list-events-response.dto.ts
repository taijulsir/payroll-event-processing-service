import { ApiProperty } from '@nestjs/swagger';
import { EventResponseDto } from './event-response.dto';

/**
 * GET /events's response envelope. Each item is the same EventResponseDto used by
 * POST /events (reused, not re-serialized) — a summary shape, without the per-event status
 * history GET /events/:id returns, since a list view doesn't need every item's full audit
 * trail. `total` lets a client render pagination without a second request.
 */
export class ListEventsResponseDto {
  @ApiProperty({ type: [EventResponseDto] })
  items!: EventResponseDto[];

  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
