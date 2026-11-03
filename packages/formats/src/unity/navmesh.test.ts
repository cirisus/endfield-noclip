import assert from 'node:assert/strict';
import { it } from 'node:test';

import { readNavTile } from './navmesh.ts';

const fixture = (): Uint8Array => {
	const bytes = new Uint8Array(72 + 36 + 32 + 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x444e4156, true);
	view.setUint32(4, 16, true);
	view.setUint32(20, 1, true);
	view.setUint32(24, 3, true);
	view.setUint32(28, 1, true);
	view.setFloat32(84, 1, true);
	view.setFloat32(104, 1, true);
	view.setUint16(110, 1, true);
	view.setUint16(112, 2, true);
	view.setUint8(136, 3);
	view.setUint8(137, 3);
	return bytes;
};
it('keeps area metadata separate from polygon vertex count', () => {
	const tile = readNavTile(fixture());
	assert.deepEqual(tile.polygons[0].vertices, [0, 1, 2]);
	assert.equal(tile.polygons[0].area, 3);
});
it('rejects truncated data, unsupported versions and invalid indices', () => {
	assert.throws(() => readNavTile(fixture().subarray(0, 100)));
	const version = fixture();
	version[4] = 17;
	assert.throws(() => readNavTile(version));
	const index = fixture();
	index[108] = 10;
	assert.throws(() => readNavTile(index));
});
