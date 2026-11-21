import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readDecalProjector } from './decal-projector.ts';

// Si's Painting's carved grid (`P_rdecal_com_marking_carving+1_003_01` in `int_drawing_puzzle_01_postmodel`)
const projector = (overrides: Record<string, unknown> = {}) => ({
	m_Enabled: 1,
	m_ShapeType: 0,
	m_CullingOption: 0,
	m_Material: { m_FileID: 4, m_PathID: -7223347700743562387n },
	m_BaseColor: { r: 1, g: 1, b: 1, a: 1 },
	m_BaseColorIntensity: 1,
	m_UvTilling: { x: 1, y: 1 },
	m_UvOffset: { x: 1, y: 1 },
	m_SectorAngle: 270,
	m_SortOrderOffset: 0,
	m_LODScreenSizeMin: 0.02,
	m_CustomMesh: { m_FileID: 0, m_PathID: 0n },
	...overrides,
});

describe('readDecalProjector', () => {
	it('takes the rect decal placement from its fields', () => {
		const { decal, unsupported } = readDecalProjector(
			projector({ m_BaseColor: { r: 0.5, g: 0.25, b: 1, a: 0.8 }, m_BaseColorIntensity: 2 }),
		);
		assert.deepEqual(decal, {
			uvScale: [1, 1],
			uvOffset: [1, 1],
			color: [0.5, 0.25, 1, 0.8],
			intensity: 2,
			sectorAngle: 270,
			flags: 0,
		});
		assert.equal(unsupported, null);
	});

	it('marks shapes other than the box, and custom meshes, unsupported', () => {
		assert.equal(readDecalProjector(projector({ m_ShapeType: 2 })).unsupported, 'decal projector shape 2');
		assert.equal(
			readDecalProjector(projector({ m_CustomMesh: { m_FileID: 1, m_PathID: 5n } })).unsupported,
			'decal projector with a custom mesh',
		);
	});
});
