import type { UnsupportedSurface, WetnessDecalSurface } from '@endfield-noclip/package-format/surfaces';

import { undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

const WETNESS_DECAL_KEYWORDS = new Set(['_USE_MASK']);

/**
 * `HGRP/WetnessDecal`, a box that wets what it covers (`docs/game-data/materials.md#wetness-decals`)
 *
 * @param reader the material's properties; each placement's alpha and UV transform are its instance row's
 * @returns its surface, or `unsupported`
 */
export const describeWetnessDecal = (reader: MaterialReader): WetnessDecalSurface | UnsupportedSurface => {
	const { float, has } = reader;
	const keywords = undrawnKeywords(reader, WETNESS_DECAL_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	let mask: WetnessDecalSurface['mask'] = null;
	if (has('_USE_MASK')) {
		const slot = reader.slot('_BaseColorMap');
		if (slot === undefined) {
			return unsupported('_USE_MASK without a mask texture');
		}
		mask = {
			texture: slot.texture,
			scale: [...slot.scale],
			offset: [...slot.offset],
			softBias: float('_UseSoftBlend', 0) * float('_SoftBias', 0),
		};
	}
	return {
		kind: 'wetnessDecal',
		mask,
		distanceFade: float('_DistanceFade', 300),
		opacity: float('_OverallOpacity', 1),
	};
};
