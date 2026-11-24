import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readWaterSurfaceSettings, volumeSurfaceSetting } from './water-volume-surfaces.ts';

describe('volumeSurfaceSetting', () => {
	// map02's WaterVolumeManagerConfig, trimmed: acid 0, plant 2, sewage 3, water 4 (the fallback), and Plant2
	// (13) borrowing plant's surface
	const pptr = (fileId: number, pathId: bigint) => ({ m_FileID: fileId, m_PathID: pathId });
	const setting = (fileId: number, pathId: bigint, decal: [number, bigint] | null = null) => ({
		surfacePrefab: pptr(fileId, pathId),
		decalPrefab: decal === null ? pptr(0, 0n) : pptr(decal[0], decal[1]),
		flowFullCycleMultiplierPerLevel: 0.005,
		flowFullCycleLargeMultiplierPerLevel: 0.005,
		largeWaveNormalScaleMultiplierPerLevel: 0.05,
	});
	const flowMultipliers = {
		flowFullCycle: 0.005,
		flowFullCycleLarge: 0.005,
		largeWaveNormalScale: 0.05,
	};
	const settings = readWaterSurfaceSettings({
		waterSurfaceMissingFallback: pptr(2, 5557907107807535942n),
		waterSurfaceSettingDict: {
			_keyData: [4, 3, 2, 0, 7],
			_valueData: [
				setting(2, 5557907107807535942n),
				setting(3, 6920472490029536733n, [4, -5287424573948146867n]),
				setting(5, -1580087855884082448n, [6, 2924707574540912839n]),
				setting(7, -9025014995019472712n, [8, -1858169792479765363n]),
				setting(9, 0n),
			],
		},
		waterTypeToSurfaceDict: { _keyData: [13], _valueData: [2] },
	});

	it('picks the surface and optional decal listed for the water type', () => {
		assert.deepEqual(volumeSurfaceSetting(settings, 0), {
			surface: { fileId: 7, pathId: -9025014995019472712n },
			decal: { fileId: 8, pathId: -1858169792479765363n },
			flowMultipliers,
		});
		assert.deepEqual(volumeSurfaceSetting(settings, 3), {
			surface: { fileId: 3, pathId: 6920472490029536733n },
			decal: { fileId: 4, pathId: -5287424573948146867n },
			flowMultipliers,
		});
		assert.deepEqual(volumeSurfaceSetting(settings, 4), {
			surface: { fileId: 2, pathId: 5557907107807535942n },
			decal: null,
			flowMultipliers,
		});
	});

	it('remaps a type before looking it up', () => {
		assert.deepEqual(volumeSurfaceSetting(settings, 13), {
			surface: { fileId: 5, pathId: -1580087855884082448n },
			decal: { fileId: 6, pathId: 2924707574540912839n },
			flowMultipliers,
		});
	});

	it('falls back for an unlisted type or a null entry', () => {
		assert.deepEqual(volumeSurfaceSetting(settings, 11), {
			surface: { fileId: 2, pathId: 5557907107807535942n },
			decal: null,
			flowMultipliers: { flowFullCycle: 0, flowFullCycleLarge: 0, largeWaveNormalScale: 0 },
		});
		assert.deepEqual(volumeSurfaceSetting(settings, 7), {
			surface: { fileId: 2, pathId: 5557907107807535942n },
			decal: null,
			flowMultipliers,
		});
	});

	it('rejects mismatched dictionary arrays', () => {
		assert.throws(
			() =>
				readWaterSurfaceSettings({
					waterSurfaceMissingFallback: pptr(0, 0n),
					waterSurfaceSettingDict: { _keyData: [0, 1], _valueData: [setting(0, 1n)] },
					waterTypeToSurfaceDict: { _keyData: [], _valueData: [] },
				}),
			/2 keys and 1 values/,
		);
	});
});
