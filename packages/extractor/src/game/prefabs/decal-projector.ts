import type { RectDecal } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { colorField, numberField, pptrField, vector2Field } from '@endfield-noclip/formats/unity/values';

// HG's `HGDecalProjector`, the prefab form of the world's rect decals (docs/game-data/materials.md#decals):
// its GameObject's transform is the box, projecting down its y, and its fields are the rect decal's
// placement under other names.

/** the class id bundles give `HGDecalProjector`, a native component */
export const DECAL_PROJECTOR_CLASS = 620548517;

/** what an `HGDecalProjector` draws, its material aside */
export interface DecalProjector {
	/** the placement, as a rect decal stores it */
	decal: RectDecal;
	/** why the viewer can't draw it as the game does, `null` when it can */
	unsupported: string | null;
}

/**
 * reads an enabled projector's placement. shapes other than the box (`m_ShapeType` 0) and custom meshes are
 * marked unsupported
 *
 * @param data the component's fields
 * @returns its placement and whether it's drawn as the game does
 */
export const readDecalProjector = (data: TypeTreeObject): DecalProjector => {
	const shape = numberField(data, 'm_ShapeType');
	let unsupported: string | null = null;
	if (shape !== 0) {
		unsupported = `decal projector shape ${shape}`;
	} else if (pptrField(data, 'm_CustomMesh').pathId !== 0n) {
		unsupported = 'decal projector with a custom mesh';
	}
	return {
		decal: {
			uvScale: vector2Field(data, 'm_UvTilling'),
			uvOffset: vector2Field(data, 'm_UvOffset'),
			color: colorField(data, 'm_BaseColor'),
			intensity: numberField(data, 'm_BaseColorIntensity'),
			sectorAngle: numberField(data, 'm_SectorAngle'),
			flags: 0,
		},
		unsupported,
	};
};
