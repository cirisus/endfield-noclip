import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { writeDds } from './dds.ts';
import { VkFormat } from './ktx2.ts';

describe('writeDds', () => {
	it('writes a valid DX10 header for a BC7 2D texture with mips', () => {
		const mip0 = new Uint8Array(64).fill(0xaa); // 8×8 BC7 = 2×2 blocks × 16 bytes
		const mip1 = new Uint8Array(16).fill(0xbb); // 4×4 BC7 = 1×1 block × 16 bytes
		const dds = writeDds({
			vkFormat: VkFormat.BC7_UNORM_BLOCK,
			width: 8,
			height: 8,
			depth: 1,
			layers: 1,
			faces: 1,
			levels: [mip0, mip1],
		});
		const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
		assert.equal(dds.byteLength, 148 + 64 + 16);
		assert.equal(new TextDecoder().decode(dds.subarray(0, 4)), 'DDS ');
		assert.equal(view.getUint32(4, true), 124);
		assert.equal(view.getUint32(12, true), 8); // height
		assert.equal(view.getUint32(16, true), 8); // width
		assert.equal(view.getUint32(20, true), 64); // linear size
		assert.equal(view.getUint32(28, true), 2); // mip count
		assert.equal(new TextDecoder().decode(dds.subarray(84, 88)), 'DX10');
		assert.equal(view.getUint32(128, true), 98); // DXGI_FORMAT_BC7_UNORM
		assert.equal(view.getUint32(140, true), 1); // arraySize
		assert.deepEqual(dds.subarray(148, 148 + 64), mip0);
		assert.deepEqual(dds.subarray(148 + 64), mip1);
	});

	it('reorders Texture2DArray levels from level-major to array-major and supports --layer / --mip', () => {
		// 2 layers, 4×4 RGBA8 (64 bytes/slice at mip 0, 16 bytes/slice at mip 1)
		const mip0 = new Uint8Array(128);
		mip0.fill(0x10, 0, 64);
		mip0.fill(0x20, 64, 128);
		const mip1 = new Uint8Array(32);
		mip1.fill(0x11, 0, 16);
		mip1.fill(0x22, 16, 32);
		const input = {
			vkFormat: VkFormat.R8G8B8A8_UNORM,
			width: 4,
			height: 4,
			depth: 1,
			layers: 2,
			faces: 1,
			levels: [mip0, mip1],
		};

		const full = writeDds(input);
		const fullView = new DataView(full.buffer);
		assert.equal(fullView.getUint32(140, true), 2);
		assert.equal(full[148], 0x10);
		assert.equal(full[148 + 64], 0x11);
		assert.equal(full[148 + 64 + 16], 0x20);
		assert.equal(full[148 + 64 + 16 + 64], 0x22);

		const single = writeDds(input, { layer: 1, mip: 1 });
		const singleView = new DataView(single.buffer);
		assert.equal(singleView.getUint32(12, true), 2);
		assert.equal(singleView.getUint32(16, true), 2);
		assert.equal(singleView.getUint32(28, true), 1);
		assert.equal(singleView.getUint32(140, true), 1);
		assert.equal(single.byteLength, 148 + 16);
		assert.equal(single[148], 0x22);
	});
});
