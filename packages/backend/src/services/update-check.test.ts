import { describe, it, expect } from 'vitest';
import { isNewer } from './update-check.js';
import { repoFromPackageJson } from '../config.js';

describe('isNewer', () => {
  it('orders semantic versions numerically', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
  });
  it('treats missing parts as zero', () => {
    expect(isNewer('1.1', '1.1.0')).toBe(false);
    expect(isNewer('1.1.1', '1.1')).toBe(true);
  });
});

describe('repoFromPackageJson', () => {
  it('reads owner/name from this project\'s package.json repository line', () => {
    expect(repoFromPackageJson()).toMatch(/^[^/]+\/[^/]+$/);
  });
});
