import { Equals, IsNumber, IsPositive, Matches } from 'class-validator';
import { BaseEventDto } from './base-event.dto';

export class SalaryChangeDto extends BaseEventDto {
  @Equals('SALARY_CHANGE')
  eventType!: 'SALARY_CHANGE';

  @IsNumber()
  @IsPositive()
  newSalary!: number;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code (e.g. EUR, USD)' })
  currency!: string;
}
