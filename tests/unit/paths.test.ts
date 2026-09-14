import { describe, expect, it } from 'vitest';
import { displayPath } from '@/lib/paths';

describe('displayPath', () => {
  const home = '/home/you';

  it('shortens a path under the home directory, and the home directory itself', () => {
    expect(displayPath('/home/you/.local/share/ai-usage-dashboard/usage.db', home)).toBe(
      '~/.local/share/ai-usage-dashboard/usage.db',
    );
    expect(displayPath('/home/you', home)).toBe('~');
    expect(displayPath('/home/you/x', '/home/you/')).toBe('~/x');
  });

  it('leaves the home directory alone when it appears anywhere but as a whole leading directory', () => {
    // A plain string replace turned these into `/mnt/backup~/usage.db` and `~ngster/usage.db`.
    expect(displayPath('/mnt/backup/home/you/usage.db', home)).toBe(
      '/mnt/backup/home/you/usage.db',
    );
    expect(displayPath('/home/youngster/usage.db', home)).toBe('/home/youngster/usage.db');
    expect(displayPath('/tmp/usage.db', home)).toBe('/tmp/usage.db');
  });

  it('shortens nothing when the home directory is empty or the filesystem root', () => {
    // Either would otherwise prefix every path with `~`.
    expect(displayPath('/tmp/usage.db', '')).toBe('/tmp/usage.db');
    expect(displayPath('/tmp/usage.db', '/')).toBe('/tmp/usage.db');
  });
});
