import type {
	TransparentDepthOnlySurface,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

/** keywords the transparent depth-only phase draws (none: vertex offset, VAT, and dither are undrawn) */
const TRANSPARENT_DEPTH_KEYWORDS: ReadonlySet<string> = new Set();

/**
 * `HGRP/Effect/VFXTransparentDepthOnly` (`docs/game-data/effects.md#transparent-depth-only`): writes depth
 * with `Blend Zero One` during the transparent pass
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` when it uses undrawn keywords or a non-LEqual depth test
 */
export const describeTransparentDepthOnly = (
	reader: MaterialReader,
): TransparentDepthOnlySurface | UnsupportedSurface => {
	const keywords = undrawnKeywords(reader, TRANSPARENT_DEPTH_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const zTest = reader.float('_ZTest', 4);
	if (zTest !== 4 || reader.float('_DisableZTest', 0) !== 0) {
		return unsupported(`_ZTest ${zTest}`);
	}
	return { kind: 'transparentDepthOnly' };
};
