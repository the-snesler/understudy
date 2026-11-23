import { describe, expect, it } from 'vitest';
import { uiAuthFromEnv } from '../src/web/auth.js';

describe('uiAuthFromEnv', () => {
  it('uses the password unless DISABLE_AUTH is set', () => {
    expect(uiAuthFromEnv({ UI_PASSWORD: 'pw' })).toEqual({ mode: 'password', password: 'pw' });
    expect(uiAuthFromEnv({ UI_PASSWORD: 'pw', DISABLE_AUTH: 'false' })).toEqual({ mode: 'password', password: 'pw' });
    expect(uiAuthFromEnv({ UI_PASSWORD: 'pw', DISABLE_AUTH: '' })).toEqual({ mode: 'password', password: 'pw' });
    expect(uiAuthFromEnv({})).toEqual({ mode: 'open' });
    expect(uiAuthFromEnv({ UI_PASSWORD: '' })).toEqual({ mode: 'open' });
  });

  it('disables auth, ignoring any password', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', ' on ']) {
      expect(uiAuthFromEnv({ DISABLE_AUTH: v })).toEqual({ mode: 'disabled', passwordIgnored: false });
    }
    expect(uiAuthFromEnv({ UI_PASSWORD: 'pw', DISABLE_AUTH: 'true' })).toEqual({ mode: 'disabled', passwordIgnored: true });
  });

  it('refuses values that are neither yes nor no', () => {
    expect(() => uiAuthFromEnv({ DISABLE_AUTH: 'ture' })).toThrow(/DISABLE_AUTH/);
  });
});
