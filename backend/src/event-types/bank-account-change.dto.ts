import { Equals, IsString, Matches } from 'class-validator';
import { BaseEventDto } from './base-event.dto';

// Basic IBAN shape check (country code + check digits + BBAN, 15-34 chars total). This is
// deliberately NOT a full mod-97 checksum validator — that would be more validation
// machinery than this assignment's scope warrants (assignment §11 asks for "information
// such as employeeId, effectiveDate, and IBAN" to be required, not a compliance-grade
// IBAN validator).
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

export class BankAccountChangeDto extends BaseEventDto {
  @Equals('BANK_ACCOUNT_CHANGE')
  eventType!: 'BANK_ACCOUNT_CHANGE';

  @IsString()
  @Matches(IBAN_PATTERN, { message: 'iban must be a plausible IBAN (e.g. DE89370400440532013000)' })
  iban!: string;
}
