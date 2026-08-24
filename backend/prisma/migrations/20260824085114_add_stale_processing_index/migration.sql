-- CreateIndex
CREATE INDEX "payroll_events_status_processing_started_at_idx" ON "payroll_events"("status", "processing_started_at");
