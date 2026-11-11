import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OidcPrincipalResolver } from '../src/admin/oidc-principal-resolver';
import { ResourcePatrolRepository } from '../src/admin/resource-patrol.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const issuer = 'https://issuer.example/realms/cyber-range';
const input = { issuer, subject: 'stable-owner-subject' };
const originalMode = process.env.PLATFORM_AUTH_MODE;
const originalIssuer = process.env.OIDC_ISSUER;
beforeEach(() => {
  process.env.PLATFORM_AUTH_MODE = 'keycloak';
  process.env.OIDC_ISSUER = issuer;
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.PLATFORM_AUTH_MODE; else process.env.PLATFORM_AUTH_MODE = originalMode;
  if (originalIssuer === undefined) delete process.env.OIDC_ISSUER; else process.env.OIDC_ISSUER = originalIssuer;
});

async function fixture() {
  const repository = createMemoryAdminRepository();
  const owner = await repository.createPlatformUser({
    id: 'original-owner-id', username: 'owner', passwordHash: 'unused',
    cloudWorkspaceId: 'space-a', isPlatformManager: false, role: 'user', status: 'active',
    oidcIssuer: issuer, oidcSubject: input.subject,
  });
  const identity = { resolve: jest.fn().mockResolvedValue({ username: 'owner', role: 'admin', workspaceIds: [] }) };
  const prisma = { cloudWorkspace: { findUnique: jest.fn().mockResolvedValue({ id: 'space-a', archivedAt: null }) } };
  const resolver = new OidcPrincipalResolver(repository, identity as never, prisma as never);
  return { repository, owner, identity, prisma, resolver };
}

describe('unified administrator role', () => {
  it('gives an existing member platform management without changing resource ownership or their stored home workspace', async () => {
    const { repository, owner, resolver, prisma } = await fixture();
    const profile = await resolver.resolve(input);
    expect(profile).toMatchObject({ id: owner.id, role: 'admin', isPlatformManager: true, cloudWorkspaceId: null });
    expect(await repository.getPlatformUserByOidcIdentity(issuer, input.subject)).toEqual(owner);
    expect(prisma.cloudWorkspace.findUnique).not.toHaveBeenCalled();
  });

  it('allows a new administrator without a workspace group and binds them by stable identity', async () => {
    const { repository, resolver, identity } = await fixture();
    identity.resolve.mockResolvedValue({ username: 'new-admin', role: 'admin', workspaceIds: [] });
    const profile = await resolver.resolve({ issuer, subject: 'new-admin-subject' });
    expect(profile).toMatchObject({ oidcSubject: 'new-admin-subject', role: 'admin', isPlatformManager: true, cloudWorkspaceId: null });
    expect(profile.id).not.toBe('original-owner-id');
    expect((await resolver.resolve({ issuer, subject: 'new-admin-subject' })).id).toBe(profile.id);
    expect(await repository.getPlatformUserByOidcIdentity(issuer, input.subject)).toMatchObject({ id: 'original-owner-id', cloudWorkspaceId: 'space-a' });
  });

  it('removes global access on the next request after demotion and restores the assigned home workspace', async () => {
    const { resolver, identity, owner, repository } = await fixture();
    await resolver.resolve(input);
    identity.resolve.mockResolvedValue({ username: 'owner', role: 'user', workspaceIds: ['space-a'] });
    expect(await resolver.resolve(input)).toMatchObject({ id: owner.id, role: 'user', isPlatformManager: false, cloudWorkspaceId: 'space-a' });
    expect(await repository.getPlatformUserByOidcIdentity(issuer, input.subject)).toEqual(owner);
    identity.resolve.mockResolvedValue({ username: 'owner', role: 'user', workspaceIds: ['space-b'] });
    await expect(resolver.resolve(input)).rejects.toBeInstanceOf(ForbiddenException);
    identity.resolve.mockResolvedValue({ username: 'owner', role: 'user', workspaceIds: [] });
    await expect(resolver.resolve(input)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when current Keycloak identity lookup fails', async () => {
    const { resolver, identity } = await fixture();
    identity.resolve.mockRejectedValue(new Error('identity unavailable'));
    await expect(resolver.resolve(input)).rejects.toThrow('identity unavailable');
  });
});

describe('background patrol administrator eligibility', () => {
  function fixture() {
    const manager = { id: 'member-promoted-to-admin', username: 'member', isPlatformManager: false, status: 'active',
      cloudWorkspaceId: 'space-a', selectedCloudWorkspaceId: 'space-b', oidcIssuer: issuer, oidcSubject: input.subject };
    const prisma = {
      platformUser: { findUnique: jest.fn().mockResolvedValue(manager) },
      cloudWorkspace: { findUnique: jest.fn().mockResolvedValue({
        id: 'space-b', provider: 'alibaba_cloud', accountUid: '222', isReadOnly: false, archivedAt: null, activeCloudAccountContextId: 'context-b',
      }) },
    };
    const identities = { resolve: jest.fn().mockResolvedValue({ id: manager.id, role: 'admin', isPlatformManager: true }) };
    return { store: new ResourcePatrolRepository(prisma as never, identities as never), manager, identities, prisma };
  }

  it('accepts an existing member granted the admin role without a stored superuser marker', async () => {
    const { store, identities } = fixture();
    expect(await store.target('member-promoted-to-admin')).toMatchObject({ managerUserId: 'member-promoted-to-admin', cloudWorkspaceId: 'space-b' });
    expect(identities.resolve).toHaveBeenCalledWith(input);
  });

  it('rejects a former administrator despite their stored marker and does not enter a scan-write transaction', async () => {
    const { store, identities, manager, prisma } = fixture();
    manager.isPlatformManager = true;
    identities.resolve.mockResolvedValue({ id: manager.id, role: 'user', isPlatformManager: false });
    await expect(store.target(manager.id)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.cloudWorkspace.findUnique).not.toHaveBeenCalled();
  });
});
