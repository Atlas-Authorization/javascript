import { describe, expect, it } from 'vitest';
import * as react from './index';

describe('connected accounts', () => {
  it('is exported', () => {
    expect(typeof react.ConnectedAccounts).toBe('function');
    expect(typeof react.useConnectedAccounts).toBe('function');
  });
});
