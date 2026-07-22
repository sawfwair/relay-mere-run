import { describe, expect, it } from 'vitest';
import { formatBytes } from '../web/src/format';

describe('fleet byte formatting', () => {
  it('keeps binary byte values aligned with their displayed units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * 1024 ** 2)).toBe('2.0 MB');
    expect(formatBytes(128 * 1024 ** 3)).toBe('128 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('reports absent capacity as unknown', () => {
    expect(formatBytes()).toBe('unknown');
    expect(formatBytes(0)).toBe('unknown');
  });
});
