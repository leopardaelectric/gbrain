# Repo brain - acme-example/service-api - learnings/aws-throttling-during-deploy-observation

Imported from `acme-example/service-api:.brain/learnings/aws-throttling-during-deploy-observation.md` on the default branch `main` at commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. [Source: GitHub API via gh CLI, 2026-01-02]

## Source Markdown

# AWS throttling during deploy observation is retried, not shown

A throttled or otherwise temporary AWS read while observing a deploy is logged once per
job per recovery retry interval and retried by the next observation; users only see it if
it outlives the 30-minute observation window.

- Incident: service-api prod deploy abcdef12 (2026-01-01) showed "Execution monitoring is
  unavailable: Rate exceeded" while the rollout was healthy and ended SUCCEEDED.
- Classifier: `src/shared/aws-transient-error.ts` (`awsThrottlingError`, `transientAwsError`).
  Access denied, not found and validation errors stay visible immediately.
- Stale errors: a successful observation clears a job error starting with
  `Execution monitoring is unavailable: ` (build jobs) or a receipt error starting with
  `Observation failed: ` (execution receipts). Other errors, such as cleanup failures, stay.
- Retries: the frontend ECS clients keep SDK `maxAttempts: 1` because UpdateService and
  RegisterTaskDefinition must never be replayed after an uncertain response. Reads retry in
  the `exampleSafeEcsReadRetry` middleware (`src/shared/aws-read-retry.ts`), with
  `EXAMPLE_AWS_READ_MAX_ATTEMPTS` (default 3) and jittered exponential backoff from
  `EXAMPLE_AWS_READ_THROTTLE_BASE_MS` (default 500) after "Rate exceeded". The shared ELB
  client uses SDK adaptive retry with the same attempt budget; its only write
  (ModifyTargetGroup) is idempotent.
