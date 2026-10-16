import { describe, expect, it } from 'vitest';
import { actorRefusal, gatesOpen, type PhotoActorContext } from './actor-context';

const ok: PhotoActorContext = {
  has_profile: true, role: 'employee', profile_deleted: false, photo_admin: false, active: true,
  schema_generation: 1, photo_writes_enabled: true, mcp_enabled: false, repair_enabled: false,
};

describe('actorRefusal', () => {
  it('lets a live employee or admin through while the gates they need are open', () => {
    expect(actorRefusal(ok, ['photo_writes_enabled'])).toBeNull();
    expect(actorRefusal({ ...ok, role: 'admin' }, ['photo_writes_enabled'])).toBeNull();
  });

  it('refuses in the order the separate reads did: profile, then account, then gates', () => {
    const closed = { ...ok, photo_writes_enabled: false };
    expect(actorRefusal(null, [])).toBe('forbidden');
    expect(actorRefusal({ ...closed, has_profile: false, active: false }, ['photo_writes_enabled'])).toBe('forbidden');
    expect(actorRefusal({ ...closed, profile_deleted: true, active: false }, ['photo_writes_enabled'])).toBe('forbidden');
    expect(actorRefusal({ ...closed, role: 'contractor' }, ['photo_writes_enabled'])).toBe('forbidden');
    expect(actorRefusal({ ...closed, role: null }, ['photo_writes_enabled'])).toBe('forbidden');
    // A banned or deleted Auth user with a live profile.
    expect(actorRefusal({ ...closed, active: false }, ['photo_writes_enabled'])).toBe('unauthenticated');
    expect(actorRefusal(closed, ['photo_writes_enabled'])).toBe('temporarily_unavailable');
    expect(actorRefusal(ok, ['photo_writes_enabled', 'mcp_enabled'])).toBe('temporarily_unavailable');
  });
});

describe('gatesOpen', () => {
  it('needs schema generation 1 and every named gate exactly true', () => {
    expect(gatesOpen(ok, [])).toBe(true);
    expect(gatesOpen(null, [])).toBe(false);
    expect(gatesOpen({ ...ok, schema_generation: 2 }, [])).toBe(false);
    expect(gatesOpen({ ...ok, schema_generation: null }, [])).toBe(false);
    expect(gatesOpen({ ...ok, repair_enabled: null }, ['repair_enabled'])).toBe(false);
  });
});
