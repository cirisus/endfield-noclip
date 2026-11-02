import type { MaterialCull, MaterialTable, TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	DitheredSurface,
	EffectStencil,
	ErosionSurface,
	GrassInputs,
	LayerCoverage,
	LeafInputs,
	LitEmission,
	LitLayer,
	LitSurface,
	LitSway,
	MattePaintingSurface,
	ParallaxGlow,
	StencilMaskSurface,
	TiledTexture,
} from '@endfield-noclip/package-format/surfaces';

import {
	type EffectLook,
	lightBeamLook,
	litDecalLook,
	mistCardLook,
	mistVolumeLook,
	multipliesScene,
	refractLook,
	sixWaySmokeLook,
	stackLook,
	waterFoamLook,
	waterSheetLook,
} from './effect-looks.ts';

/** {@link unsupportedLook}'s colour, linear magenta */
const UNSUPPORTED_COLOR: [r: number, g: number, b: number] = [1, 0, 1];

/** the side of {@link unsupportedLook}'s checker cells, in metres */
const UNSUPPORTED_CELL = 0.5;

/**
 * the texture slots the mesh shader samples, in binding order. the frame group leaves seven sampled textures
 * of WebGPU's default sixteen, so slots are shared where materials rarely use both: the third holds `_MROMap`
 * in the MRO layout and the tri-channel `_MaskMap` otherwise ({@link LookFlags.TriChannelMask}), and looks
 * with {@link LookFlags.LayerBlend} put the layer's `_Layer1BaseMap` and `_Layer1BumpMap` in the parallax
 * slots (no map02 material has both keywords) and its `_LayerBlendMaskMap` in the emissive slot
 */
export const SLOTS = [
	'_BaseColorMap',
	'_NormalMap',
	'_MROMap',
	'_EmissiveMap',
	'_DetailMap',
	'_ParallaxMap',
	'_ParallaxNoiseMap',
] as const;

/** a slot samples UV set 1 when bit `UV1_SHIFT + slot` of {@link MaterialLook.flags} is set, else UV set 0 */
export const UV1_SHIFT = 18;

/** {@link MaterialLook.flags} bits, matching `mesh.wgsl` */
export const LookFlags = {
	/** the slots of {@link SLOTS} that have a texture ({@link SLOT_FLAGS}) */
	BaseMap: 1 << 0,
	NormalMap: 1 << 1,
	MaskMap: 1 << 2,
	EmissiveMap: 1 << 3,
	/** normal x is `r · a` (DXT5nm-style; BC5 has a = 1) */
	NormalRag: 1 << 4,
	/** the normal map's B channel is roughness */
	NormalRoughness: 1 << 5,
	/** thin foliage: transmission, two-sided lighting */
	Foliage: 1 << 6,
	/** metallic is the base colour's alpha instead of the surface row's constant */
	MetallicBaseAlpha: 1 << 7,
	/** the normal map's alpha is the material occlusion */
	NormalOcclusion: 1 << 8,
	// bits 9 and 10 are the geometry's flags (mesh-renderer.ts)
	/** emission is the emissive colour times a channel of the material's own maps (`_EMISSIVE_MASK`) */
	EmissiveMask: 1 << 11,
	/** unlit: the tinted base colour is the radiance (matte paintings; see `mattePaintingLook`) */
	Unlit: 1 << 12,
	/** the alpha test reads the normal map's alpha instead of the base colour's (`_AlphaMaskChannel` 1) */
	AlphaNormal: 1 << 13,
	/** the mask slot holds the tri-channel `_MaskMap` rather than an MRO map */
	TriChannelMask: 1 << 14,
	DetailMap: 1 << 15,
	ParallaxMap: 1 << 16,
	ParallaxNoiseMap: 1 << 17,
	// bits UV1_SHIFT… pick each slot's UV set
	/** `HGRP/Erosion`: slots and parameters as {@link erosionLook} lays them out */
	Erosion: 1 << 25,
	// bit 26 is the geometry's (mesh-renderer.ts)
	/** `HGRP/Foliage/Leaf`: the sun shadow, vertex-normal lighting and canopy ramp of {@link LookRow.foliage} */
	FoliageLeaf: 1 << 27,
	/** a scene effect (effect-looks.ts), drawn by `effect.wgsl` in the transparent pass */
	Effect: 1 << 28,
	/** with {@link Effect}: a VFXDecal box, projected onto the surfaces inside it */
	EffectDecal: 1 << 29,
	/**
	 * with {@link Effect}: mist (`MistRow` in effect-looks.ts), a FogSimple card, or with {@link EffectDecal} a
	 * VFXFakeVolumeFog box, drawn by its back faces like a decal's
	 */
	EffectMist: 1 << 30,
	/**
	 * `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK`: the parallax slots and rows hold the layer
	 * ({@link layerBlendParams}). the sign bit, so the value is negative; `words` in mesh-renderer.ts store it
	 * unsigned
	 */
	LayerBlend: 1 << 31,
} as const;

/** the slot flags of {@link LookFlags} by slot, which are cleared while a slot's texture isn't resident */
export const SLOT_FLAGS = [
	LookFlags.BaseMap,
	LookFlags.NormalMap,
	LookFlags.MaskMap,
	LookFlags.EmissiveMap,
	LookFlags.DetailMap,
	LookFlags.ParallaxMap,
	LookFlags.ParallaxNoiseMap,
];

/**
 * floats of a material's draw parameters (`Draw` in mesh.wgsl after the dequantization); rows in
 * {@link LookRow}
 */
export const LOOK_FLOATS = 144;

/** one material as the mesh shader draws it */
export interface MaterialLook {
	/** `false` for materials the game draws nothing visible with (water proxies, lit decals that change nothing) */
	drawn: boolean;
	/** a material the viewer can't draw, shown as a magenta checker ({@link unsupportedLook}) */
	unsupported: boolean;
	/**
	 * alpha-tested against the alpha of the base colour, or of the normal map with
	 * {@link LookFlags.AlphaNormal} (`fs_cutout_depth` in mesh.wgsl), once that texture is bound
	 * ({@link alphaTextureOf}); such draws need pipelines that can discard
	 */
	cutout: boolean;
	/**
	 * alpha-blended: drawn in the transparent pass with the opacity `fs_transparent` in mesh.wgsl computes, and
	 * never alpha-tested or shadow-casting
	 */
	transparent: boolean;
	/** authored queue for layers composited after depth of field, otherwise null */
	afterDof: number | null;
	/** the faces the game culls, for unmirrored instances */
	cull: MaterialCull;
	/** whether the material draws into shadow maps */
	castsShadows: boolean;
	/** texture id per {@link SLOTS} entry, or -1 */
	textures: number[];
	/** largest UV scale of each slot, for picking the mip level to stream */
	uvScales: number[];
	/** a 3D texture an effect samples besides its slots (the mist boxes' noise), or -1 */
	volumeTexture: number;
	/** {@link LookFlags}, with every slot that has a texture set */
	flags: number;
	/** {@link LOOK_FLOATS} draw parameters */
	params: Float32Array;
	/** the stencil test and write of effects that mask each other, or `null` for the rest */
	stencil: LookStencil | null;
	/**
	 * with {@link LookFlags.EffectDecal}: a lit decal that changes only the normal, roughness or occlusion of
	 * the surface beneath, drawn by the decal relight pass into the main pass's radiance rather than in the
	 * transparent pass
	 */
	relight: boolean;
	/**
	 * with {@link LookFlags.Effect}: an effect drawn over the composited scene rather than in the transparent
	 * pass, because it multiplies what lies behind (`'multiply'`) or samples it (`'refract'`), or a WaterDecal
	 * box drawn into the water's foam before the water draws (`'waterFoam'`, depth-tested in front of the
	 * scene, or `'waterFoamBehind'`, behind it); `null` for the rest
	 */
	screen: ScreenEffect | null;
}

/** how an effect drawn after compositing ({@link MaterialLook.screen}) reaches the image */
export type ScreenEffect = 'multiply' | 'refract' | 'waterFoam' | 'waterFoamBehind';

/**
 * a draw's stencil state and the depth test that goes with it, from its material's `_Stencil*` and `_ZTest`
 * properties, for VFXBaseV2 portals (`docs/viewer/effects.md#portals`)
 */
export interface LookStencil {
	compare: GPUCompareFunction;
	/** whether passing fragments write the reference (Unity's Replace); the rest keep the stencil */
	replace: boolean;
	reference: number;
	readMask: number;
	writeMask: number;
	/** the depth test, mapped to reversed-Z */
	depthCompare: GPUCompareFunction;
	/**
	 * a stencil-only look: it writes the stencil where its surface passes the depth test, but neither colour
	 * nor depth, and draws in the main pass after the opaque surfaces
	 */
	maskOnly: boolean;
}

/** float offsets of the rows of {@link MaterialLook.params} */
export const LookRow = {
	/** linear tint, alpha-test threshold */
	tint: 0,
	/** one UV transform per slot */
	uv: 4,
	/**
	 * roughness min, roughness max, metallic, normal scale; unlit looks: highlight threshold and intensity, the
	 * side of the checker cells in metres (0 for none; {@link unsupportedLook})
	 */
	surface: 32,
	/** occlusion strength, f0, transmission, base colour brighter scale */
	surface2: 36,
	/** emissive colour (linear), how much the tint covers the base colour */
	emissive: 40,
	/**
	 * `_AlbedoAffectEmissive` (1: emission ignores the albedo), `_EmissiveMaskChannel`, `_IgnorePostExposure`
	 * (1: emission keeps its brightness whatever the exposure), the opacity of transparent looks before their
	 * texture's alpha (`_BaseColor.a`)
	 */
	emissive2: 44,
	/** three rows, the tri-channel mask's R, G and B: linear colour, strength */
	maskAlbedo: 48,
	/** the roughness each mask channel blends toward */
	maskRoughness: 60,
	/** the metallic each mask channel blends toward */
	maskMetallic: 64,
	/** per channel, the mask's contrast (`_Mask*Scale`) */
	maskScale: 68,
	/** per channel, the mask's offset (`_Mask*Offset`) */
	maskOffset: 72,
	/** `_DetailMode` (0 colour overlay, 1 PBR), `_DetailMaskMode`, normal intensity, PBR intensity */
	detail: 76,
	/**
	 * view depths where the detail starts and finishes fading out, overlay brighter scale (transparent looks,
	 * which have no detail map: 1 for premultiplied blending), 1 when the surface keeps lit decals off ({@link
	 * keepsLitDecalsOff})
	 */
	detail2: 80,
	/** `_DetailOverlayColor`: linear colour, how much it covers */
	detailOverlay: 84,
	/**
	 * parallax depth (`_ParallaxStrength`), march steps, Fresnel power, pulse amplitude. `_EMISSIVE_ANIM` looks
	 * reuse this row and the next ({@link EmissivePulseRow})
	 */
	parallax: 88,
	/** pulse phase per second, pulse phase per metre of the object's position, ignore post exposure, pulse mean */
	parallax2: 92,
	/** `_ParallaxColor` (HDR, as stored) times `_ParallaxIntensity`, mask channel */
	parallaxColor: 96,
	/** `_ParallaxColorDark` times `_ParallaxIntensity` */
	parallaxDark: 100,
	/** the glow's brightening near the player: outer and inner radius, strength (0 without `_ParallaxCharPos`) */
	parallaxBright: 104,
	/**
	 * leaves: `_OcclusionShadow` (how much the vertex AO shadows the sun), the fake directional shadow's
	 * strength and power, `_DiffuseUseVertexNormal`. grass: `_BendNormalUpward`, the camera lean's intensity,
	 * `_MaskOnDiffuse`, `_MaskOnTransmission`. Lit layers reuse this row and the next ({@link LayerBlendRow})
	 */
	foliage: 108,
	/**
	 * leaves: the vertex AO ranges that fade transmission and subsurface in: start, range, start, range. grass:
	 * the occlusion ramp's start height, its rate, its strength (1 − `_AoParams.z`), 1 for `_TwoSidedNormal`
	 */
	foliageAo: 112,
	/**
	 * leaves: `_SubsurfaceIntensity`, `_TransmissionDistanceFade`, the canopy ramp's intensity (0 without
	 * `_CANOPY_COLOR_RAMP`), 1 when the ramp starts at the top. grass: `_SubsurfaceIntensity`, then the sun
	 * mask ramp's start height, rate and strength (`_DirParams`)
	 */
	foliage2: 116,
	/** leaves: the canopy ramp's range, transition range, colour brighter scale, how much its colour covers */
	canopy: 120,
	/** leaves: `_CanopyRampColor`, linear */
	canopyColor: 124,
	/**
	 * three rows, the HDR colours the emissive map's G, B and A add ({@link LitEmission.channels}); effect
	 * looks use these rows for their own (`EffectRow` in effect-looks.ts)
	 */
	emissiveChannels: 128,
} as const;

/**
 * @param look a material look
 * @returns the texture id whose alpha an alpha-tested look tests, or -1 when it has none
 */
export const alphaTextureOf = (look: MaterialLook): number =>
	look.textures[(look.flags & LookFlags.AlphaNormal) !== 0 ? 1 : 0];

/** a look with no textures and identity UV transforms */
const emptyLook = ({ drawn }: { drawn: boolean }): MaterialLook => {
	const params = new Float32Array(LOOK_FLOATS);
	for (let i = 0; i < SLOTS.length; i++) {
		params.set([1, 1, 0, 0], LookRow.uv + i * 4);
	}
	return {
		drawn,
		unsupported: false,
		cutout: false,
		transparent: false,
		afterDof: null,
		cull: 'none',
		castsShadows: true,
		textures: SLOTS.map(() => -1),
		uvScales: SLOTS.map(() => 1),
		volumeTexture: -1,
		flags: 0,
		params,
		stencil: null,
		relight: false,
		screen: null,
	};
};

/**
 * unsupported material: a world-space magenta/black checker, unlit and exposure-independent. draws both faces
 * and casts no shadow. also the look of `DrawRole.Unsupported` stand-ins
 *
 * @returns a new look
 */
export const unsupportedLook = (): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.unsupported = true;
	look.castsShadows = false;
	look.flags |= LookFlags.Unlit;
	look.params.set([...UNSUPPORTED_COLOR, -1], LookRow.tint);
	look.params.set([1, 0, UNSUPPORTED_CELL], LookRow.surface);
	look.params[LookRow.emissive2 + 2] = 1;
	return look;
};

/** a depth comparison under the viewer's reversed-Z */
const reversedDepthCompare = (compare: GPUCompareFunction): GPUCompareFunction => {
	switch (compare) {
		case 'less': {
			return 'greater';
		}
		case 'less-equal': {
			return 'greater-equal';
		}
		case 'greater': {
			return 'less';
		}
		case 'greater-equal': {
			return 'less-equal';
		}
		default: {
			return compare;
		}
	}
};

/** an effect's stencil state as the viewer draws it: the depth test under reversed-Z */
const lookStencilOf = (stencil: EffectStencil, maskOnly: boolean): LookStencil => ({
	...stencil,
	depthCompare: reversedDepthCompare(stencil.depthCompare),
	maskOnly,
});

/** the stencil-only look of a portal's mask ({@link StencilMaskSurface}) */
const stencilMaskLook = (mask: StencilMaskSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.castsShadows = false;
	look.stencil = lookStencilOf(mask.stencil, true);
	return look;
};

/**
 * @param materials the package's material table
 * @returns a look per material id
 */
export const materialLooks = (materials: MaterialTable): MaterialLook[] => {
	const looks: MaterialLook[] = [];
	for (const entry of materials.entries) {
		// a material that didn't convert (its reason is in debug/assets.json) has nothing to draw by
		if (entry.status !== 'ready') {
			looks[entry.id] = unsupportedLook();
			continue;
		}
		const surface = entry.surface;
		switch (surface.kind) {
			case 'undrawn': {
				looks[entry.id] = emptyLook({ drawn: false });
				break;
			}
			case 'unsupported': {
				looks[entry.id] = unsupportedLook();
				break;
			}
			case 'mattePainting': {
				looks[entry.id] = mattePaintingLook(surface, entry.cull);
				break;
			}
			case 'erosion': {
				looks[entry.id] = erosionLook(surface, entry.cull);
				break;
			}
			case 'dithered': {
				looks[entry.id] = ditheredLook(surface, entry.cull);
				break;
			}
			case 'lit': {
				looks[entry.id] = litLook(surface, entry.cull);
				break;
			}
			case 'mistCard': {
				looks[entry.id] = effectMaterialLook(mistCardLook(surface), {
					flags: LookFlags.Effect | LookFlags.EffectMist,
					cull: entry.cull,
				});
				break;
			}
			case 'mistVolume': {
				looks[entry.id] = effectMaterialLook(mistVolumeLook(surface), {
					flags: LookFlags.Effect | LookFlags.EffectMist | LookFlags.EffectDecal,
					cull: entry.cull,
				});
				break;
			}
			case 'lightBeam': {
				looks[entry.id] = effectMaterialLook(lightBeamLook(surface), {
					flags: LookFlags.Effect,
					cull: entry.cull,
				});
				break;
			}
			case 'effectStack': {
				const effect = stackLook(surface);
				looks[entry.id] = effectMaterialLook(effect, {
					flags: LookFlags.Effect | (surface.variant === 'decal' ? LookFlags.EffectDecal : 0),
					cull: entry.cull,
					stencil: surface.stencil === null ? null : lookStencilOf(surface.stencil, false),
					// drawn over the composited scene
					screen: multipliesScene(effect) ? 'multiply' : null,
				});
				break;
			}
			case 'stencilMask': {
				looks[entry.id] = stencilMaskLook(surface, entry.cull);
				break;
			}
			case 'waterSheet': {
				looks[entry.id] = effectMaterialLook(waterSheetLook(surface), {
					flags: LookFlags.Effect,
					cull: entry.cull,
				});
				break;
			}
			case 'sixWaySmoke': {
				looks[entry.id] = effectMaterialLook(sixWaySmokeLook(surface), {
					flags: LookFlags.Effect,
					cull: entry.cull,
				});
				break;
			}
			case 'litDecal': {
				looks[entry.id] = effectMaterialLook(litDecalLook(surface), {
					flags: LookFlags.Effect | LookFlags.EffectDecal,
					cull: entry.cull,
					relight: surface.relight,
				});
				break;
			}
			case 'refract': {
				looks[entry.id] = effectMaterialLook(refractLook(surface), {
					flags: LookFlags.Effect,
					cull: entry.cull,
					screen: 'refract',
				});
				break;
			}
			case 'waterFoam': {
				looks[entry.id] = effectMaterialLook(waterFoamLook(surface), {
					flags: LookFlags.Effect,
					cull: entry.cull,
					screen: surface.depthTest === 'lessEqual' ? 'waterFoam' : 'waterFoamBehind',
				});
				break;
			}
		}
		const look = looks[entry.id];
		const queue = entry.renderQueue;
		if (look.transparent && !look.unsupported && queue !== undefined && queue >= 3660 && queue <= 3740) {
			look.afterDof = queue;
		}
	}
	return looks;
};

/**
 * @returns the look of a scene effect: alpha-blended and shadowless. decal boxes draw their back faces, so
 *   they still show with the camera inside them
 */
const effectMaterialLook = (
	effect: EffectLook,
	{
		flags,
		cull,
		stencil = null,
		relight = false,
		screen = null,
	}: {
		/** {@link LookFlags.Effect} and the kind's flags */
		flags: number;
		cull: MaterialCull;
		stencil?: LookStencil | null;
		relight?: boolean;
		screen?: ScreenEffect | null;
	},
): MaterialLook => ({
	drawn: true,
	unsupported: false,
	cutout: false,
	transparent: true,
	afterDof: null,
	cull: (flags & LookFlags.EffectDecal) !== 0 ? 'front' : cull,
	castsShadows: false,
	textures: effect.textures,
	uvScales: effect.uvScales,
	volumeTexture: effect.volumeTexture,
	flags,
	params: effect.params,
	stencil,
	relight,
	screen,
});

/**
 * the Lit model ({@link LitSurface}). slots are shared where materials rarely use both ({@link SLOTS}): the
 * MRO layout's map takes the tri-channel mask's slot, which therefore isn't drawn there, and a mask layer's
 * mask map the emissive map's, so mask layers on emissive-mapped materials aren't drawn. `_EMISSIVE_ANIM`'s
 * pulse keeps its inputs in the parallax rows, so it stays still on surfaces with a parallax glow or a layer
 */
const litLook = (surface: LitSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	const params = look.params;
	const { textures, emission } = surface;
	const triChannel = surface.layout === 'mro' ? null : surface.triChannel;
	if (textures.base !== null) {
		setTexture(look, 0, textures.base);
	}
	if (textures.normal !== null) {
		setTexture(look, 1, textures.normal);
	}
	const mask = textures.mro ?? triChannel?.mask ?? null;
	if (mask !== null) {
		setTexture(look, 2, mask);
	}
	if (textures.emissive !== null) {
		setTexture(look, 3, textures.emissive);
	}
	if (surface.detail !== null) {
		setTexture(look, 4, surface.detail.texture);
	}

	switch (surface.layout) {
		case 'mro': {
			look.flags |= LookFlags.NormalRag;
			break;
		}
		case 'twoBasemap': {
			// the two-basemap layout's occlusion and metallic sources (docs/game-data/materials.md#texture-layouts)
			look.flags |= LookFlags.NormalRoughness | LookFlags.NormalOcclusion;
			if (surface.metallicFromBaseAlpha) {
				look.flags |= LookFlags.MetallicBaseAlpha;
			}
			break;
		}
		case 'roughnessInB': {
			look.flags |= LookFlags.NormalRoughness;
			break;
		}
		case 'plain': {
			break;
		}
	}
	if (surface.foliage !== null) {
		look.flags |= LookFlags.Foliage;
	}
	if (surface.alphaFromNormal) {
		look.flags |= LookFlags.AlphaNormal;
	}

	// base colour: tinted and brightened, then covered by the tint
	params.set([...surface.tint, surface.alphaClip ?? -1], LookRow.tint);
	// glass: the opacity is the alpha the alpha test would read, times its own. glass casting a solid shadow
	// would darken what lies behind it, so it casts none
	if (surface.blend !== 'opaque') {
		look.transparent = true;
		look.castsShadows = false;
		params[LookRow.emissive2 + 3] = surface.opacity;
		params[LookRow.detail2 + 2] = surface.blend === 'premultiplied' ? 1 : 0;
	}
	look.cutout =
		!look.transparent && surface.alphaClip !== null && surface.alphaClip >= 0 && alphaTextureOf(look) >= 0;
	params[LookRow.emissive + 3] = surface.tintCover;
	params.set(
		[surface.roughness[0], surface.roughness[1], surface.metallic, surface.normalScale],
		LookRow.surface,
	);
	params.set(
		[surface.occlusionStrength, surface.f0, surface.transmission, surface.brighterScale],
		LookRow.surface2,
	);
	switch (surface.foliage?.kind) {
		case 'leaf': {
			leafParams(look, surface.foliage);
			break;
		}
		case 'grass': {
			grassParams(look, surface.foliage);
			break;
		}
		default: {
			break;
		}
	}

	if (emission !== null) {
		if (emission.source === 'mask') {
			look.flags |= LookFlags.EmissiveMask;
		}
		params.set(emission.color, LookRow.emissive);
		params.set([emission.albedoAffect, emission.maskChannel, emission.ignorePostExposure], LookRow.emissive2);
		emission.channels?.forEach((rgb, i) => {
			params.set(rgb, LookRow.emissiveChannels + i * 4);
		});
	}

	if (triChannel !== null) {
		look.flags |= LookFlags.TriChannelMask;
		triChannel.channels.forEach((channel, i) => {
			params.set([...channel.albedo, channel.strength], LookRow.maskAlbedo + i * 4);
			params[LookRow.maskRoughness + i] = channel.roughness;
			params[LookRow.maskMetallic + i] = channel.metallic;
			params[LookRow.maskScale + i] = channel.scale;
			params[LookRow.maskOffset + i] = channel.offset;
		});
	}

	const { detail } = surface;
	if (detail !== null) {
		params.set([detail.mode, detail.maskMode, detail.normalIntensity, detail.pbrIntensity], LookRow.detail);
		params.set([detail.fade[0], detail.fade[1], detail.brighterScale], LookRow.detail2);
		params.set([...detail.overlay, detail.overlayCover], LookRow.detailOverlay);
	}

	const { overlay } = surface;
	const layerSource =
		overlay?.kind === 'layer' && !(overlay.coverage.kind === 'maskMap' && textures.emissive !== null)
			? LAYER_SOURCES[overlay.coverage.kind]
			: null;
	if (overlay?.kind === 'parallax') {
		parallaxParams(look, overlay);
	} else if (overlay?.kind === 'layer' && layerSource !== null) {
		layerBlendParams(look, overlay, layerSource);
	} else if (emission?.pulse != null) {
		emissivePulseParams(look, emission.pulse);
	}
	if (surface.keepsLitDecalsOff) {
		params[LookRow.detail2 + 3] = 1;
	}
	if (surface.sway !== null && surface.foliage === null) {
		swayParams(look, surface.sway);
	}
	return look;
};

/**
 * where `_SIMPLE_VERTEXANIM_CLOTH`'s sway keeps its inputs: rows only leaves and grass use otherwise.
 * mesh.wgsl sways a vertex of a look that isn't foliage, erosion, unlit or an effect when the frequency or
 * intensity is non-zero and the geometry's position W (the sway weight) is
 */
export const SwayRow = {
	/** `_SimpleVertexAnimationWindIntensity`, `_SimpleVertexAnimationWindFreq`, the soft factor, `_Kite` */
	sway: LookRow.foliage2,
	/** `_DirectionTendency`, 1 for the material's own direction (0: the wind's), that direction's X and Z */
	direction: LookRow.canopyColor,
} as const;

/** `_SIMPLE_VERTEXANIM_CLOTH`'s sway in the wind (docs/game-data/materials.md#swaying-cloth) */
const swayParams = (look: MaterialLook, sway: LitSway): void => {
	look.params.set([sway.intensity, sway.frequency, sway.softness, sway.kite], SwayRow.sway);
	look.params.set(
		[sway.tendency, sway.direction === null ? 0 : 1, ...(sway.direction ?? [0, 0])],
		SwayRow.direction,
	);
};

/**
 * where `_EMISSIVE_ANIM`'s pulse keeps its inputs. a look without parallax or layer maps leaves their rows
 * free; mesh.wgsl pulses emission when the interval is positive
 */
export const EmissivePulseRow = {
	/** pulse cycles per second, phase offset (`_EmissiveAnimRandom`), interval, minimum brightness */
	pulse: LookRow.parallax,
	/** how much the pulse dims the emission (`_EmissiveColor.a`) */
	strength: LookRow.parallax2,
} as const;

/** `_EMISSIVE_ANIM`'s pulse (docs/game-data/materials.md#emission) */
const emissivePulseParams = (look: MaterialLook, pulse: NonNullable<LitEmission['pulse']>): void => {
	look.params.set([pulse.rate, pulse.phase, pulse.interval, pulse.minimum], EmissivePulseRow.pulse);
	look.params[EmissivePulseRow.strength] = pulse.depth;
};

/** `HGRP/Foliage/Leaf`'s inputs to the two-sided foliage lighting (`docs/game-data/materials.md#foliage`) */
const leafParams = (look: MaterialLook, leaf: LeafInputs): void => {
	const params = look.params;
	look.flags |= LookFlags.FoliageLeaf;
	params.set(
		[leaf.occlusionShadow, leaf.fakeShadow.strength, leaf.fakeShadow.power, leaf.diffuseUsesVertexNormal],
		LookRow.foliage,
	);
	params.set([...leaf.aoTransmission, ...leaf.aoSubsurface], LookRow.foliageAo);
	const canopy = leaf.canopy;
	params.set(
		[
			leaf.subsurface,
			leaf.transmissionDistanceFade,
			canopy?.intensity ?? 0,
			canopy?.startsAtTop === true ? 1 : 0,
		],
		LookRow.foliage2,
	);
	params.set(
		[canopy?.range ?? 0, canopy?.transition ?? 0, canopy?.brighterScale ?? 1, canopy?.cover ?? 0],
		LookRow.canopy,
	);
	params.set(canopy?.color ?? [1, 1, 1], LookRow.canopyColor);
};

/**
 * `HGRP/Foliage/Grass` and its card LOD: their inputs to the two-sided foliage lighting, the bent normal and
 * the lean away from the camera (`docs/game-data/materials.md#foliage`), in the leaf rows. zeros leave a row
 * neutral
 */
const grassParams = (look: MaterialLook, grass: GrassInputs): void => {
	const params = look.params;
	params.set(
		[grass.bendNormalUpward, grass.cameraLean, grass.maskOnDiffuse, grass.maskOnTransmission],
		LookRow.foliage,
	);
	params.set([...grass.ao, grass.twoSidedNormal ? 1 : 0], LookRow.foliageAo);
	params.set([grass.subsurface, ...grass.sunMask], LookRow.foliage2);
};

/** binds a texture to slot `i`, tiled by its own scale on UV set `uv` */
const setTiledTexture = (
	look: MaterialLook,
	i: number,
	texture: number,
	tiling: number,
	uv: number,
): void => {
	look.textures[i] = texture;
	look.uvScales[i] = Math.max(Math.abs(tiling), 1e-3);
	look.flags |= SLOT_FLAGS[i] | (uv << (UV1_SHIFT + i));
	look.params.set([tiling, tiling, 0, 0], LookRow.uv + i * 4);
};

/** `_PARALLAX_MAP`'s glow (`docs/game-data/materials.md#lit-layers`), in the parallax slots and rows */
const parallaxParams = (look: MaterialLook, glow: ParallaxGlow): void => {
	const params = look.params;
	// the noise follows the pattern's UV set. without one the noise flag stays clear, and the march reads height 0
	setTiledTexture(look, 5, glow.pattern.texture, glow.patternTiling, glow.pattern.uv);
	if (glow.noise !== null) {
		setTiledTexture(look, 6, glow.noise, glow.noiseTiling, glow.pattern.uv);
	}
	// the pulse runs between the minimum brightness and 1
	const minimum = glow.pulseMinimum;
	params.set([glow.depth, glow.steps, glow.fresnelPower, (1 - minimum) / 2], LookRow.parallax);
	params.set(
		[glow.pulseRate, glow.pulsePhasePerMetre, glow.ignorePostExposure, (1 + minimum) / 2],
		LookRow.parallax2,
	);
	params.set([...glow.bright, glow.maskChannel], LookRow.parallaxColor);
	params.set(glow.dark, LookRow.parallaxDark);
	// the brightening near the player, whom the viewer places at the camera
	params.set([glow.near.outer, glow.near.inner, glow.near.strength], LookRow.parallaxBright);
};

/** what decides how much a layer covers ({@link LayerBlendRow.height}'s last float) */
export const LayerSource = {
	/** `_LAYERBLEND_TOP`: how far the surface faces up */
	Top: 0,
	/** `_LAYERBLEND_MASK` with `_LayerBlendMaskType` 0: `_LayerBlendMaskMap`'s R, in the emissive slot */
	MaskMap: 1,
	/** `_LayerBlendMaskType` 1: the layer bump map's alpha */
	LayerBumpAlpha: 2,
	/** `_LayerBlendMaskType` 2: the base colour's alpha */
	BaseAlpha: 3,
	/** `_LayerBlendMaskType` 3: the normal map's alpha */
	NormalAlpha: 4,
	/** `_LayerBlendMaskType` 4: everywhere */
	Full: 5,
} as const;

type LayerSource = (typeof LayerSource)[keyof typeof LayerSource];

/** each {@link LayerCoverage}'s {@link LayerSource} */
const LAYER_SOURCES: Record<LayerCoverage['kind'], LayerSource> = {
	top: LayerSource.Top,
	maskMap: LayerSource.MaskMap,
	layerBumpAlpha: LayerSource.LayerBumpAlpha,
	baseAlpha: LayerSource.BaseAlpha,
	normalAlpha: LayerSource.NormalAlpha,
	full: LayerSource.Full,
};

/** float offsets of a layer's parameters ({@link layerBlendParams}), which reuse the parallax and leaf rows */
export const LayerBlendRow = {
	/**
	 * how much the bumped normal decides top coverage (`_TopBlendWithBumpMap`), `_TopBlendThreshold`,
	 * `_TopBlendSmoothness`, the layer's coordinates (`_LayerBlendUVType`: 0 UV set 0, 1 world XZ, 2 UV set 2)
	 */
	coverage: LookRow.parallax,
	/**
	 * 1 for the height blend (`_LayerBlendHeight`), `_LayerBlendHeightTransition`, the base's height, the
	 * coverage source ({@link LayerSource})
	 */
	height: LookRow.parallax2,
	/** linear `_Layer1TintColor` times `_Layer1ColorBrighterScale`, how much colour the layer keeps */
	color: LookRow.parallaxColor,
	/**
	 * `_Layer1BaseColorBlendMode` (0 replace, 1 add), its additive intensity, `_LayerMetallicType`,
	 * `_Layer1Metallic`
	 */
	blend: LookRow.parallaxDark,
	/** `_Layer1BumpScale`, `_Layer1BaseNormalIntensity`, `_Layer1AOStrength`, `_LayerAOType` */
	normal: LookRow.parallaxBright,
	/**
	 * `_LAYERBLEND_MOSS`: `_Layer1FuzzyCoreDarkness`, `…EdgeBrightness`, `…EdgeShadowRange`,
	 * `…EdgeShadowOffset`; neutral without the keyword
	 */
	fuzzy: LookRow.foliage,
	/** `_Layer1FuzzyEdgeShadowIntensity`, `…DarkPower`, `…BrightPower`, `…NormalStrength` */
	fuzzy2: LookRow.foliageAo,
} as const;

/**
 * `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK`, with `_LAYERBLEND_MOSS`'s fuzzy shading
 * (`docs/game-data/materials.md#lit-layers`), in the parallax slots and rows. both maps sample one
 * coordinate, tiled and offset by the layer's own values; the mask map samples untiled in the emissive slot.
 * UV set 2 isn't loaded and reads as set 0, and `_BaseHeightMap` has no slot and reads as the shader's grey
 * default (0.5)
 */
const layerBlendParams = (look: MaterialLook, layer: LitLayer, source: LayerSource): void => {
	const params = look.params;
	look.flags |= LookFlags.LayerBlend;
	if (layer.coverage.kind === 'maskMap') {
		setTiledTexture(look, 3, layer.coverage.texture, 1, layer.coverage.uv);
	}
	for (const [slot, texture] of [
		[5, layer.base],
		[6, layer.bump],
	] as const) {
		setTiledTexture(look, slot, texture, layer.tiling, 0);
		params.set(layer.offset, LookRow.uv + slot * 4 + 2);
	}
	params.set(
		[layer.top.bumped, layer.top.threshold, layer.top.smoothness, layer.uvType],
		LayerBlendRow.coverage,
	);
	params.set(
		[layer.heightTransition === null ? 0 : 1, layer.heightTransition ?? 1, 0.5, source],
		LayerBlendRow.height,
	);
	params.set([...layer.tint, layer.saturation], LayerBlendRow.color);
	params.set(
		[layer.colorBlendMode, layer.additiveIntensity, layer.metallicType, layer.metallic],
		LayerBlendRow.blend,
	);
	params.set(
		[layer.bumpScale, layer.baseNormalIntensity, layer.aoStrength, layer.aoType],
		LayerBlendRow.normal,
	);
	// neutral fuzz: no darkening, brightening or edge shadow, a unit range so the edge term stays finite
	let fuzzy = [0, 0, 1, 0];
	let fuzzy2 = [0, 1, 1, 0];
	const { moss } = layer;
	if (moss !== null) {
		fuzzy = [moss.coreDarkness, moss.edgeBrightness, moss.edgeShadowRange, moss.edgeShadowOffset];
		fuzzy2 = [moss.edgeShadowIntensity, moss.darkPower, moss.brightPower, moss.normalStrength];
	}
	params.set(fuzzy, LayerBlendRow.fuzzy);
	params.set(fuzzy2, LayerBlendRow.fuzzy2);
};

/**
 * float offsets of an {@link erosionLook}'s parameters, which reuse the rows of {@link LookRow} that the Lit
 * layers use
 */
export const ErosionRow = {
	/** linear `_BaseColor`, no alpha test */
	base: LookRow.tint,
	/** `_Roughness`, `_DetailRoughnessCover`, `_Metallic`, `_NormalScale` */
	surface: LookRow.surface,
	/** `_OcclusionStrength`, f0, `_MetallicOffset`, `_DetailNormalScale` */
	surface2: LookRow.surface2,
	/** `_NoiseEmissiveStrength`, `_FlowColorStrength`, `_FlowColorEmissiveStrength`, `_DistanceBlend` */
	strengths: LookRow.emissive,
	/** `_MetallicColor`, `_NoiseStrength` (the noise layer's depth) */
	metal: LookRow.maskAlbedo,
	/** `_NoisePatternTintColor`, `_NoiseMin` */
	noise: LookRow.maskAlbedo + 4,
	/** `_NoisePatternAlphaTintColor`, `_FlowColorOffset` */
	noiseAlpha: LookRow.maskAlbedo + 8,
	/** `_FlowTopColor`, `_FlowRoughness` */
	flowTop: LookRow.maskRoughness,
	/** `_FlowBottomColor` */
	flowBottom: LookRow.maskMetallic,
	/** `_FlowNormalTilling`, `_FlowNoiseStrength`, ramp scroll per second, `_FlowSpeedOffset` */
	flow: LookRow.maskScale,
} as const;

/**
 * erosion rock ({@link ErosionSurface}). its textures take {@link SLOTS}' places: the base normal map the
 * normal slot, the metal map the mask slot, the flow ramp the emissive slot, the detail normal map the detail
 * slot, and the noise pattern both parallax slots (tiled, then untiled for the march)
 */
const erosionLook = (surface: ErosionSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.flags |= LookFlags.Erosion;
	const params = look.params;
	const { textures, noise, flow } = surface;
	const slots: [number, TiledTexture | null][] = [
		[1, textures.baseNormal],
		[2, textures.metalMix],
		[3, textures.flowRamp === null ? null : { texture: textures.flowRamp, tiling: 1 }],
		[4, textures.detailNormal],
		[5, textures.noisePattern],
		[6, textures.noisePattern === null ? null : { ...textures.noisePattern, tiling: 1 }],
	];
	for (const [i, texture] of slots) {
		if (texture === null) {
			continue;
		}
		look.textures[i] = texture.texture;
		// the ramp is sampled at its finest level whatever its size on screen
		look.uvScales[i] = i === 3 ? 0 : Math.max(Math.abs(texture.tiling), 1e-3);
		look.flags |= SLOT_FLAGS[i];
		params.set([texture.tiling, texture.tiling, 0, 0], LookRow.uv + i * 4);
	}
	params.set([...surface.baseColor, -1], ErosionRow.base);
	params.set(
		[surface.roughness, surface.detailRoughnessCover, surface.metallic, surface.normalScale],
		ErosionRow.surface,
	);
	params.set(
		[surface.occlusionStrength, surface.f0, surface.metallicOffset, surface.detailNormalScale],
		ErosionRow.surface2,
	);
	params.set(
		[noise.emissiveStrength, flow.colorStrength, flow.emissiveStrength, noise.fadeDistance],
		ErosionRow.strengths,
	);
	params.set([...surface.metallicColor, noise.depth], ErosionRow.metal);
	params.set([...noise.tint, noise.min], ErosionRow.noise);
	params.set([...noise.alphaTint, flow.colorOffset], ErosionRow.noiseAlpha);
	params.set([...flow.top, flow.roughness], ErosionRow.flowTop);
	params.set(flow.bottom, ErosionRow.flowBottom);
	params.set([flow.tiling, flow.noiseStrength, flow.scroll, flow.speedOffset], ErosionRow.flow);
	return look;
};

/**
 * the row of a dithered VFXDitherAlpha look (one whose alpha-test threshold, `tint.w`, is negative), which
 * reuses the leaves' canopy row
 */
export const DitherRow = {
	/**
	 * the alpha scale (`_TintColor.a · _TintColorAlpha`), `_DitherAlphaExp`, `_DitherTilling`, 1 when the alpha
	 * is the red of the texture (`_UseMainTexAsAlpha`) rather than its alpha
	 */
	dither: LookRow.canopy,
} as const;

/**
 * a dithered effect ({@link DitheredSurface}), drawn like an opaque surface; the shader has no shadow caster
 * pass
 */
const ditheredLook = (surface: DitheredSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.castsShadows = false;
	const params = look.params;
	if (surface.baseMap !== null) {
		setTexture(look, 0, surface.baseMap);
	}
	if (surface.normalMap !== null) {
		setTexture(look, 1, surface.normalMap);
	}
	const { dither } = surface;
	if (dither !== null) {
		// an unlit look can borrow the normal slot to test the main texture's red as the alpha alone
		if (dither.redAlpha) {
			setTexture(look, 1, dither.texture);
			look.flags |= LookFlags.AlphaNormal;
		}
		params.set(
			[dither.alphaScale, dither.exponent, dither.tiling, dither.redAlpha ? 1 : 0],
			DitherRow.dither,
		);
		look.cutout = true;
	}
	const { color, lighting } = surface;
	if (lighting === null) {
		// unlit: the radiance, as the matte painting's path draws it, with no highlight (zero intensity)
		look.flags |= LookFlags.Unlit;
		params.set([...color, -1], LookRow.tint);
		params[LookRow.emissive2 + 2] = surface.ignorePostExposure;
		return look;
	}
	look.flags |= LookFlags.NormalRag;
	// untextured, the tint is the albedo, which the G-buffer saturates
	const untextured = look.textures[0] < 0;
	params.set([...(untextured ? color.map((c) => Math.min(c, 1)) : color), -1], LookRow.tint);
	params.set(
		[lighting.roughness, lighting.roughness, lighting.metallic, lighting.normalScale],
		LookRow.surface,
	);
	params.set([1, 0.04, 0, 1], LookRow.surface2);
	params[LookRow.emissive + 3] = untextured ? 1 : 0;
	return look;
};

/** a matte painting ({@link MattePaintingSurface}): unlit, and the shader has no shadow caster pass */
const mattePaintingLook = (surface: MattePaintingSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.castsShadows = false;
	look.flags |= LookFlags.Unlit;
	const params = look.params;
	if (surface.texture !== null) {
		setTexture(look, 0, surface.texture);
	}
	const threshold = surface.alphaClip ?? -1;
	params.set([...surface.color, threshold], LookRow.tint);
	look.cutout = threshold >= 0 && look.textures[0] >= 0;
	params[LookRow.surface] = surface.highlight.threshold;
	params[LookRow.surface + 1] = surface.highlight.intensity;
	params[LookRow.emissive2 + 2] = surface.ignorePostExposure;
	return look;
};

/** binds a texture to a slot of {@link SLOTS} with its UV set and `_ST` transform */
const setTexture = (look: MaterialLook, i: number, slot: TextureSlot): void => {
	look.textures[i] = slot.texture;
	look.uvScales[i] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
	look.flags |= SLOT_FLAGS[i] | (slot.uv << (UV1_SHIFT + i));
	look.params.set([...slot.scale, ...slot.offset], LookRow.uv + i * 4);
};
