import type { MaterialCull, ReadyMaterial } from '@endfield-noclip/package-format/materials';

/**
 * a material table entry for the look tests
 *
 * @param surface the surface the extractor described
 * @param cull the faces the material culls
 * @returns a converted material in the default transparent queue, without gaps, holding still
 */
export const described = (surface: ReadyMaterial['surface'], cull: MaterialCull = 'back'): ReadyMaterial => ({
	status: 'ready',
	cull,
	renderQueue: 3000,
	surface,
	gaps: [],
	motion: null,
});
