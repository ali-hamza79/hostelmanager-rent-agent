export type AuthDestination = 'login' | 'setup' | 'dashboard';

export function resolveAuthDestination(
  isAuthenticated: boolean,
  hasLinkedUserProfile: boolean,
  hasCloudHostelProfile: boolean,
): AuthDestination {
  if (!isAuthenticated) return 'login';
  return hasLinkedUserProfile && hasCloudHostelProfile ? 'dashboard' : 'setup';
}
