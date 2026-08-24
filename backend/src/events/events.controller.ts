import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { validateEventPayload } from '../event-types/validate-event-payload';
import { EventsService } from './events.service';
import { EventResponseDto, toEventResponseDto } from './dto/event-response.dto';
import { EventDetailResponseDto, toEventDetailResponseDto } from './dto/event-detail-response.dto';
import { DEFAULT_LIST_LIMIT, ListEventsQueryDto } from './dto/list-events-query.dto';
import { ListEventsResponseDto } from './dto/list-events-response.dto';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  // Rate limiting, scoped to this route only (not GET /events, GET /events/:id, or /health) —
  // see events.constants.ts (EVENTS_SUBMIT_RATE_LIMIT*) for the configured limit/window and its
  // rationale. This is abuse protection at the HTTP edge, independent of and unrelated to the
  // retry/backoff/ordering/reconciliation mechanisms further down the processing pipeline.
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary: 'Submit a payroll event for asynchronous processing',
    description:
      'Persists the event as PENDING and returns immediately — it does not wait for ' +
      'processing (added in a later phase) to complete.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated key identifying this logical submission attempt. Retrying the same key returns the original event instead of creating a duplicate.',
  })
  @ApiResponse({
    status: 202,
    description: 'Event accepted (or a matching prior submission was found).',
    type: EventResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid request: missing Idempotency-Key, unknown eventType, or invalid/missing fields.',
  })
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was already used with a different request payload.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — rate limit exceeded for this client.',
  })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EventResponseDto> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const { eventType, payload } = await validateEventPayload(body);
    const { event } = await this.eventsService.submit(idempotencyKey, eventType, payload);

    res.set('Location', `/events/${event.id}`);
    return toEventResponseDto(event);
  }

  @Get()
  @ApiOperation({
    summary: 'List submitted events',
    description:
      'Simple, bounded list with optional employeeId/status filters and offset pagination ' +
      '(architecture.md §6) — no search or sort options.',
  })
  @ApiResponse({ status: 200, type: ListEventsResponseDto })
  async findMany(@Query() query: ListEventsQueryDto): Promise<ListEventsResponseDto> {
    const { items, total } = await this.eventsService.findMany(query);
    return {
      items: items.map(toEventResponseDto),
      total,
      limit: query.limit ?? DEFAULT_LIST_LIMIT,
      offset: query.offset ?? 0,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Retrieve one event',
    description:
      'Returns the persisted event — type, payload, current status, attempts, ' +
      'result/failure detail, and its full status history. Events are always PENDING at ' +
      'this phase; processing is introduced in a later phase.',
  })
  @ApiResponse({ status: 200, type: EventDetailResponseDto })
  @ApiResponse({ status: 404, description: 'No event exists with this id.' })
  async findOne(
    @Param(
      'id',
      new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Event not found') }),
    )
    id: string,
  ): Promise<EventDetailResponseDto> {
    const event = await this.eventsService.findById(id);
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    const history = await this.eventsService.findHistory(id);
    return toEventDetailResponseDto(event, history);
  }
}
