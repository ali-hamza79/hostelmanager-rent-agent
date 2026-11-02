import { describe, expect, it } from 'vitest';
import { resolveAuthDestination } from './authRouting';

describe('resolveAuthDestination', () => {
  it('shows login when there is no authenticated user', () => {
    expect(resolveAuthDestination(false, false, false)).toBe('login');
  });

  it('sends an authenticated user without a cloud hostel profile to setup', () => {
    expect(resolveAuthDestination(true, false, false)).toBe('setup');
  });

  it('sends an authenticated user with a cloud hostel profile to the dashboard', () => {
    expect(resolveAuthDestination(true, true, true)).toBe('dashboard');
  });

  it('requires setup when a hostel exists but is not linked to the signed-in user', () => {
    expect(resolveAuthDestination(true, false, true)).toBe('setup');
  });

  it('requires setup when a user link exists but the hostel profile is missing', () => {
    expect(resolveAuthDestination(true, true, false)).toBe('setup');
  });
});
