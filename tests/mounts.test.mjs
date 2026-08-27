import test from 'node:test';
import assert from 'node:assert/strict';

import { listMountRoots, parseMountInfo } from '../server/mounts.mjs';

test('parseMountInfo decodes mount points from /proc/self/mountinfo', () => {
  const entries = parseMountInfo(`
24 23 0:20 / /library rw,relatime - ext4 /dev/sda rw
25 23 0:21 / /taotu\\040合集 rw,relatime - ext4 /dev/sdb rw
`);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].mountPoint, '/library');
  assert.equal(entries[1].mountPoint, '/taotu 合集');
  assert.equal(entries[1].fileSystemType, 'ext4');
});

test('listMountRoots returns all detected mount points without filtering', async () => {
  const mounts = await listMountRoots({
    readFile: async () => `
24 23 0:20 / /library rw,relatime - ext4 /dev/sda rw
25 23 0:21 / /proc rw,relatime - proc proc rw
26 23 0:22 / /taotu rw,relatime - ext4 /dev/sdb rw
27 23 0:22 / /library rw,relatime - ext4 /dev/sda rw
`,
  });

  assert.deepEqual(mounts, ['/library', '/proc', '/taotu']);
});
