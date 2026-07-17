import type { SessionUserProfile } from '../admin/admin-user-auth';

export type RequestAuthContext = {
  user: SessionUserProfile;
  source: 'web' | 'mcp';
  oauthClientId: string | null;
};

export type AuthenticatedPlatformRequest = {
  headers: Record<string, string | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
  adminUser: SessionUserProfile;
  authContext: RequestAuthContext;
};
