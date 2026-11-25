import { FormatError } from '../binary/binary-reader.ts';
import {
	type PlainKinds,
	type PlainObject,
	type PlainOptions,
	type PlainResult,
	plainKinds,
	toPlainObject,
} from '../unity/plain-object.ts';
import type { TypeTreeNode } from '../unity/serialized-file.ts';
import type { TypeTreeObject } from '../unity/type-tree.ts';
import { isObject, stringField } from '../unity/values.ts';

// `HGEnvironmentPhase` MonoBehaviours (`EnvParse/Env_*.asset`): one complete environment as a list of
// `HG*Config` sections, each with an `m_active` flag. see `docs/game-data/environment.md#environment-phases`.

/** the sections read, by their field name in the phase */
export const ENVIRONMENT_SECTIONS = [
	'lightConfig',
	'skyConfig',
	'atmosphereConfig',
	'fogConfig',
	'heightFogConfig',
	'volumetricFogConfig',
	'cloudConfig',
	'windConfig',
	'lightShaftConfig',
	'colorGradingConfig',
	'autoExposureConfig',
	'shadowConfig',
	'celestialConfig',
	'starConfig',
	'rainConfig',
	'snowConfig',
	'lensFlareConfig',
] as const;

/** a section's field name */
export type EnvironmentSectionName = (typeof ENVIRONMENT_SECTIONS)[number];

/** one section, converted to plain JSON */
export interface EnvironmentSection {
	/** the section's `m_active` */
	active: boolean;
	/**
	 * the section's fields under their own names (see `unity/plain-object.ts` for the value mapping), without
	 * `m_*` bookkeeping fields, colour curves, or object references other than textures, materials and lens
	 * flare data, which are `null`
	 */
	value: PlainObject;
	/** what each field of {@link value} holds, by its TypeTree type */
	kinds: PlainKinds;
	/** the texture references, by field path within {@link value} */
	textures: PlainResult['pptrs'];
	/** the material references (the celestial bodies' draw materials), by field path within {@link value} */
	materials: PlainResult['pptrs'];
	/**
	 * the `LensFlareDataSRP` references (the sun's lens flare), by field path within {@link value}; read them
	 * with `unity/lens-flare-data.ts`
	 */
	flares: PlainResult['pptrs'];
}

/** a decoded phase */
export interface EnvironmentPhase {
	name: string;
	sections: Record<EnvironmentSectionName, EnvironmentSection>;
}

const TEXTURE_PPTR = /^PPtr<\$?(?:Texture|Texture2D|Texture3D|Cubemap|Texture2DArray|CubemapArray)>$/;
const MATERIAL_PPTR = /^PPtr<\$?Material>$/;
const FLARE_PPTR = /^PPtr<\$?LensFlareDataSRP>$/;

/** sub-structs that are big and unused outside the editor */
const DROPPED_TYPES = new Set(['HGColorCurve']);

/**
 * @param nodes the MonoBehaviour's flattened TypeTree
 * @param object the MonoBehaviour as read with it
 * @returns the phase's name and sections
 * @throws {FormatError} if a section is missing
 */
export const readEnvironmentPhase = (
	nodes: readonly TypeTreeNode[],
	object: TypeTreeObject,
): EnvironmentPhase => {
	const options: PlainOptions = {
		// editor-only previews (`customIVCubemapMapForEdit`) aren't shipped textures the client samples
		keepPPtr: (type, name) =>
			(TEXTURE_PPTR.test(type) || MATERIAL_PPTR.test(type) || FLARE_PPTR.test(type)) &&
			!name.endsWith('ForEdit'),
		// `m_active` is read separately below; `m_backup*`/`m_prev*` are editor state
		dropField: (name, type) => (name.startsWith('m_') && name !== 'm_Name') || DROPPED_TYPES.has(type),
	};
	const { value, pptrs } = toPlainObject(nodes, object, options);
	const kinds = plainKinds(nodes, options);
	const pptrsBySection = new Map<
		string,
		{ textures: PlainResult['pptrs']; materials: PlainResult['pptrs']; flares: PlainResult['pptrs'] }
	>();
	for (const { path, type, pptr } of pptrs) {
		const root = path[0];
		if (typeof root !== 'string') {
			continue;
		}
		let bucket = pptrsBySection.get(root);
		if (bucket === undefined) {
			bucket = { textures: [], materials: [], flares: [] };
			pptrsBySection.set(root, bucket);
		}
		const entry = { path: path.slice(1), type, pptr };
		if (TEXTURE_PPTR.test(type)) {
			bucket.textures.push(entry);
		} else if (MATERIAL_PPTR.test(type)) {
			bucket.materials.push(entry);
		} else if (FLARE_PPTR.test(type)) {
			bucket.flares.push(entry);
		}
	}
	const section = (name: EnvironmentSectionName): EnvironmentSection => {
		const raw = object[name];
		const converted = value[name];
		if (
			!isObject(raw) ||
			converted === undefined ||
			converted === null ||
			typeof converted !== 'object' ||
			Array.isArray(converted)
		) {
			throw new FormatError(`environment phase has no ${name}`);
		}
		const refs = pptrsBySection.get(name);
		const sectionKinds = kinds[name];
		return {
			active: raw.m_active === undefined ? true : raw.m_active !== 0 && raw.m_active !== false,
			value: converted,
			kinds: typeof sectionKinds === 'object' ? sectionKinds : {},
			textures: refs?.textures ?? [],
			materials: refs?.materials ?? [],
			flares: refs?.flares ?? [],
		};
	};
	return { name: stringField(object, 'm_Name'), sections: mapSections(section) };
};

/**
 * @param fn makes one section's value
 * @returns every section's value
 */
export const mapSections = <T>(
	fn: (name: EnvironmentSectionName) => T,
): Record<EnvironmentSectionName, T> => {
	const result: Partial<Record<EnvironmentSectionName, T>> = {};
	for (const name of ENVIRONMENT_SECTIONS) {
		result[name] = fn(name);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every section was just filled in
	return result as Record<EnvironmentSectionName, T>;
};
