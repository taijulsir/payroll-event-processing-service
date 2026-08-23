import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

/**
 * Fields common to every supported payroll event type (assignment "Supported Event
 * Types" — employeeId and effectiveDate appear on all three). Each concrete per-type DTO
 * extends this and adds its own type-specific fields plus a fixed `eventType` literal.
 */
export abstract class BaseEventDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsDateString()
  effectiveDate!: string;
}
