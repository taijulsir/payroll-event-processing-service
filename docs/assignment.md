# Backend Engineering Technical

# Assignment

## Payroll Event Processing Service

## Purpose

Build a small, production-oriented backend service that demonstrates your ability to design
reliable asynchronous workflows using the Node.js ecosystem. We are evaluating
engineering judgment, not the amount of code written.

## Time Expectation

Please aim to complete the assignment within 2–3 days. A smaller, correct, well-tested
solution is preferred over a large application with unnecessary features.

## Technology Requirements

● Node.js
● TypeScript
● NestJS
● PostgreSQL
● Redis
● BullMQ
● Docker / Docker Compose
● Git
● GitHub Actions
You may choose Prisma, Drizzle, TypeORM, or another suitable PostgreSQL data-access
library. You may add other backend libraries where appropriate. A minimal frontend is
required to demonstrate the application, but there are no restrictions on the frontend
framework, language, component library, or tooling you choose.

## Minimal Frontend Demonstration

A minimal frontend is required so the completed work can be demonstrated as a usable
application rather than only as API endpoints.


The frontend should be clean, simple, and easy to understand. It does not need advanced
visual design or a large number of screens. Its purpose is to make the important backend
behavior visible and easy to demonstrate.
At minimum, the interface should allow someone to:
● submit one of the supported payroll events
● view submitted events
● open an event and inspect its current status and details
● see the processing result or useful failure information
● clearly observe important processing-state changes
There are no restrictions on the frontend technology. You may use any framework, library,
language, component system, styling approach, or tooling you prefer. The frontend should
consume the backend you build rather than act as a mocked standalone demo.
Frontend implementation quality will be considered mainly in terms of usability, clarity, and
how effectively it demonstrates the backend system. The primary technical focus of this
assignment remains backend engineering.

## Project Scenario

Build a backend service that receives and processes employee payroll-related events. The
system should support three event types: bank account changes, address changes, and
salary changes.
Processing may involve slow or unreliable external systems. Your solution should therefore
separate request handling from the actual processing work and should remain reliable when
failures, retries, duplicate requests, or multiple workers are involved.

## Supported Event Types

### BANK_ACCOUNT_CHANGE

**Example fields:**
● employeeId
● effectiveDate
● iban


### ADDRESS_CHANGE

**Example fields:**
● employeeId
● effectiveDate
● street
● city
● postalCode
● country

### SALARY_CHANGE

**Example fields:**
● employeeId
● effectiveDate
● newSalary
● currency
You are free to design the request structure differently if you believe another structure is
better. Explain important design choices in the README.

## Functional Requirements

### 1. Event Submission

Provide an API endpoint for submitting a payroll event, for example POST /events.
The system should validate the request, persist the information it needs, accept the event for
processing, and return a useful response. Processing may take several seconds, so the
HTTP request should not remain open unnecessarily while all processing is completed.

### 2. Event Status

Provide an API endpoint for retrieving an event, for example GET /events/:id.
The response should make it possible to understand what event was submitted, its current
processing state, whether it succeeded or failed, and relevant result or failure information.
You should decide which event states are necessary and what transitions between those
states make sense.


### 3. Asynchronous Processing

Payroll events must be processed asynchronously using Redis and BullMQ.
For this assignment, do not integrate with a real payroll provider. Create a simulated
payroll-processing operation that performs business validation, simulates communication
with an external payroll system, stores a result, and occasionally fails so failure scenarios
can be demonstrated and tested.

### 4. Temporary and Permanent Failures

Assume that the simulated external payroll system is not always available.
A temporary failure should not immediately make an event permanently unsuccessful. At the
same time, some errors may never succeed regardless of repeated attempts.
Design the system so both situations are handled appropriately. An engineer investigating an
unsuccessful event should be able to understand what happened.

### 5. Duplicate Requests

Assume that a client may retry an HTTP request because of a network problem.
The same business request may therefore reach the API more than once. The same payroll
change must not be applied multiple times simply because the request was submitted
repeatedly.
Your implementation should demonstrate how this situation is handled.

### 6. Multiple Workers and Concurrency

Assume that the production system may eventually run multiple worker processes or
instances.
The design must prevent a payroll event from accidentally being applied more than once and
must remain correct when multiple workers are available.

### 7. Worker Failure and Recovery

Assume that a worker can stop unexpectedly while processing an event.
After the system becomes available again, the event should not remain permanently stuck in
an incorrect state. The system should recover in a reasonable and explainable way.


### 8. Processing Consistency

**Consider this scenario:**

1. A worker receives an event.
2. The payroll operation succeeds.
3. Database changes are written.
4. The worker crashes before processing is considered finished.
5. The event is later processed again.
Your implementation should ensure that this situation does not corrupt data or apply the
same payroll change twice.

### 9. Event Ordering

Events belonging to the same employee must be processed in the order in which the system
accepted them.
For example, if an address change is accepted before a salary change for the same
employee, the later event should not incorrectly overtake the earlier event.
Events for different employees should still be able to process concurrently. Do not
unnecessarily process the entire system sequentially.

### 10. Extensibility

Only three event types are required.
Assume that a real system could later add events such as:
● EMPLOYEE_TERMINATION
● TAX_CLASS_CHANGE
● WORKING_HOURS_CHANGE
● BONUS_PAYMENT
Your architecture should make it reasonably easy to introduce new event types without
rewriting the whole processing system. You do not need to implement these additional
events.

### 11. Validation

Each event type has different required information.


BANK_ACCOUNT_CHANGE should require information such as employeeId, effectiveDate,
and IBAN.
ADDRESS_CHANGE should require employeeId, effectiveDate, street, city, postalCode, and
country.
SALARY_CHANGE should require employeeId, effectiveDate, newSalary, and currency.
Invalid input should return an appropriate API response.

### 12. Event History and Audit Information

Payroll systems require traceability.
Store enough information to understand the important lifecycle of an event, including when it
was submitted, when processing started, whether processing succeeded, whether it failed,
and useful failure information.
You may decide the exact data model and implementation.

## Testing Requirements

Automated testing is required.
We are intentionally not prescribing an exact number of unit, integration, functional, or
end-to-end tests. Choose the testing strategy you believe is appropriate.
Your automated tests should provide confidence in important scenarios, including:
● a valid event can be submitted
● invalid events are rejected
● an accepted event can be processed
● processing results are persisted
● temporary failures are handled
● permanent failure is represented clearly
● duplicate requests do not create duplicate business operations
● important concurrency scenarios do not corrupt data
● worker recovery behavior is demonstrated where practical
You may use Jest, Supertest, NestJS testing utilities, or other appropriate tools. Be prepared
to explain why particular tests are unit, integration, functional, or end-to-end tests.

## Docker and Local Development

The project should be easy to run locally.


A command such as docker compose up should start the required environment. Your setup
will likely include:
● NestJS API
● worker process
● PostgreSQL
● Redis
● minimal frontend application
The API and worker may share application code, but background processing should not
depend on keeping an HTTP request alive.

## CI Pipeline

Create a GitHub Actions CI pipeline.
The purpose of the pipeline is to prevent code that does not meet the project's quality
requirements from being merged. Decide which automated checks belong in the pipeline
and demonstrate that it runs successfully.

## Error Handling and Logging

Return appropriate API responses for invalid input, unknown event types, missing events,
and unexpected server errors.
Background failures must also be handled explicitly rather than silently ignored.
Provide useful logs for important activity such as:
● event accepted
● processing started
● processing failed
● processing succeeded
● important retry or recovery behavior

## Health Check

Provide a simple health endpoint, for example GET /health.
It should provide useful information about whether the application is operational. How deeply
you check external dependencies is your design decision.


## API Documentation

Provide enough documentation for the API to be tested easily.
Swagger / OpenAPI is preferred, but a Postman collection, README examples, or clear curl
commands are also acceptable.

## README and Architecture

The repository must contain a useful README.
**It should explain:**
● installation
● environment variables
● Docker setup
● database setup and migrations
● starting the API
● starting the worker
● running tests
● overall architecture
● database design
● background processing design
● important engineering decisions and trade-offs
Also include a small architecture diagram. It does not need to be professionally designed; a
simple diagram showing the main components and data flow is sufficient.

## Scope — What Is Not Required

Do not spend significant time building unrelated functionality.
**The following are not required:**
● advanced or feature-heavy frontend application
● authentication or user registration
● admin dashboard
● complete HR system
● complete payroll application
● complex UI
● dozens of payroll event types
● real payroll-provider integration
● Kubernetes
● complex cloud infrastructure
Focus on the backend engineering problem.


## AI Usage

Use of AI development tools is allowed.
You may use ChatGPT, Claude, GitHub Copilot, Codex, Cursor, or similar tools. We are not
evaluating whether every line of code was written manually.
We are evaluating whether you understand the system you submit and the engineering
decisions behind it. After submission, you may be asked to explain or modify parts of your
own implementation.

## Submission Checklist

● GitHub repository link
● minimal frontend demonstration
● README with setup instructions
● working Docker setup
● database schema and migrations
● automated tests
● GitHub Actions workflow
● API documentation
● short architecture/design explanation
Optional additions are welcome when they genuinely improve engineering quality, but
unnecessary scope will not receive extra credit.

## Technical Review After Submission

After submission, we will hold a technical discussion about your implementation.
**Be prepared to:**
● walk through the lifecycle of an event
● explain the architecture and database design
● explain the asynchronous processing approach
● explain what happens during failure and recovery
● explain how duplicate processing is prevented
● explain the testing strategy
● explain the CI pipeline
● discuss trade-offs
● make or describe small changes to your implementation


The discussion will focus on your reasoning and understanding rather than memorized
definitions.

## Evaluation

The assignment will primarily be evaluated on:
● Backend architecture and code quality — High importance
● NestJS and Node.js ecosystem understanding — High importance
● Asynchronous processing and queue design — High importance
● Reliability and failure handling — High importance
● PostgreSQL and data modeling — High importance
● Testing quality — High importance
● Docker and local development experience — Medium importance
● CI/CD quality — Medium importance
● Documentation — Medium importance
● Frontend usability and demonstration quality — Medium importance
● Ability to explain engineering decisions — Very high importance
We prefer a smaller solution that is correct, understandable, testable, and reliable over an
unnecessarily complicated solution.


