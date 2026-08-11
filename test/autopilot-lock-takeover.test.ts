import { describe, expect, test } from 'bun:test';
import { shouldTakeOverAutopilotLock } from '../src/commands/autopilot.ts';

describe('shouldTakeOverAutopilotLock', () => {
  test('never takes over when the existing PID is still alive', () => {
    expect(
      shouldTakeOverAutopilotLock(1234, 99, {
        selfPid: 5678,
        isPidAlive: () => true,
      }),
    ).toBe(false);
  });

  test('takes over when the PID is dead, even if the lock is still fresh', () => {
    expect(
      shouldTakeOverAutopilotLock(1234, 11, {
        selfPid: 5678,
        isPidAlive: () => false,
      }),
    ).toBe(true);
    expect(
      shouldTakeOverAutopilotLock(1234, 9, {
        selfPid: 5678,
        isPidAlive: () => false,
      }),
    ).toBe(true);
  });
});
