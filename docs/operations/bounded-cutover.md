# Bounded GBrain cutover

Use `scripts/gbrain-cutover.sh` only for the final service-interrupting command of
a prepared maintenance. Keep Postgres, HTTP, and autopilot active while you plan,
test, build, verify, commit, push, take backups, and prepare rollback.

## Prepare

1. Make the cutover command transactional, or prepare and test its specific
   rollback command.
2. Complete all work that does not require stopped services.
3. Keep the command below 60 seconds. Split longer work into an online phase and
   a short cutover phase.
4. Put the command and every argument after the required `--` delimiter. The
   helper does not evaluate a shell command string.

## Run

```bash
scripts/gbrain-cutover.sh -- COMMAND ARGUMENT...
```

Example for a prepared transactional SQL file:

```bash
scripts/gbrain-cutover.sh -- \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /path/to/prepared-cutover.sql
```

The default command timeout is 60 seconds. Set a different bound only when the
prepared cutover has a measured runtime and rollback:

```bash
scripts/gbrain-cutover.sh --timeout-seconds 90 -- COMMAND ARGUMENT...
```

The accepted range is 1 through 3600 seconds. Do not increase the timeout to
make unprepared work fit inside the outage.

## Helper contract

Before the cut, the helper refuses to continue unless these checks pass:

- `gbrain-postgres.service` is active.
- `gbrain-http.service` is active.
- `gbrain-autopilot.service` is active.
- `http://127.0.0.1:3131/health` returns success.

The helper then stops autopilot and HTTP, runs the command through GNU
`timeout`, and gives a process that ignores the timeout signal five seconds
before a forced kill. It restores HTTP and autopilot from an `EXIT` trap. The
trap runs on normal exit, command failure, timeout, `INT`, and `TERM`. After
restart, the helper polls local health and verifies that autopilot is active
before it returns.

The helper keeps the command exit status when the command fails. GNU `timeout`
uses exit status 124 for a timeout. A restoration failure changes a successful
command result to exit status 1 and prints the failed restoration check.

## Failure handling

The helper restores service availability. It does not roll back database or
file changes. If the command is not transactional, run the prepared rollback
for that command after the services recover. Do not use a generic rollback for
an arbitrary cutover.
