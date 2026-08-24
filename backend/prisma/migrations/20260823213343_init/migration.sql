-- CreateTable
CREATE TABLE "payroll_events" (
    "id" UUID NOT NULL,
    "employee_id" VARCHAR NOT NULL,
    "event_type" VARCHAR NOT NULL,
    "sequence" BIGINT NOT NULL,
    "idempotency_key" VARCHAR NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "result" JSONB,
    "failure_reason" TEXT,
    "failure_type" VARCHAR,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ(6),
    "processing_finished_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_status_history" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "from_status" VARCHAR,
    "to_status" VARCHAR NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_number" INTEGER,
    "error_message" TEXT,
    "metadata" JSONB,

    CONSTRAINT "event_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_events_idempotency_key_key" ON "payroll_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "payroll_events_status_submitted_at_idx" ON "payroll_events"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_events_employee_id_sequence_key" ON "payroll_events"("employee_id", "sequence");

-- CreateIndex
CREATE INDEX "event_status_history_event_id_occurred_at_idx" ON "event_status_history"("event_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "event_status_history" ADD CONSTRAINT "event_status_history_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "payroll_events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CheckConstraint
-- Approved database-level invariants that Prisma's schema language cannot express
-- declaratively (see prisma/schema.prisma header and docs/database-design.md §7).
-- Deliberately NOT added: a CHECK on `status` or `event_type` — both were reviewed and
-- rejected in favor of application-layer validation only (database-design.md §7/§16).
ALTER TABLE "payroll_events" ADD CONSTRAINT "payroll_events_failure_type_check"
  CHECK ("failure_type" IN ('RETRYABLE', 'PERMANENT') OR "failure_type" IS NULL);

ALTER TABLE "payroll_events" ADD CONSTRAINT "payroll_events_attempts_check"
  CHECK ("attempts" >= 0);

ALTER TABLE "payroll_events" ADD CONSTRAINT "payroll_events_max_attempts_check"
  CHECK ("max_attempts" > 0);

ALTER TABLE "payroll_events" ADD CONSTRAINT "payroll_events_sequence_check"
  CHECK ("sequence" > 0);
