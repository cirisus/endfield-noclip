import { FormatError } from '../binary/binary-reader.ts';

import { asMemoryPackObject, asMemoryPackVec3, type MemoryPackValue } from './memory-pack.ts';

/** a placed interactive, before runtime scripts and facility upgrades */
export interface LevelInteractive {
	id: bigint;
	template: string;
	createState: number;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
	modelScale: number;
	/** whether the placement starts locked */
	isLocked: boolean;
	/** the placement's own values for its entity's properties, overriding its template's */
	properties: InteractiveParam[];
	/** the placement's parameters for its template's components, by the game's interactive component type */
	componentProperties: Map<number, InteractiveParam[]>;
}

/** a keyed parameter authored on an interactive placement */
export interface InteractiveParam {
	key: string;
	/** the game's parameter value type */
	type: number;
	/** each value atom: its 64 raw bits and its string (pooled; `null` when absent) */
	values: { bits: bigint; text: string | null }[];
}

/** a named place from a HUD region-toast function area (`SceneToastUIData`) */
export interface LevelPlace {
	/** localization key for the place's display name (`subTitle.key`) */
	subTitleKey: string;
	/** axis-aligned box center in world space */
	center: [number, number, number];
	/** approximate bounding radius of the area box in metres */
	radius: number;
	/** toast priority (1 for named sub-areas, 0 for level-wide fallback) */
	priority: number;
}

/** the interactives and function-area summary read from a decoded LevelData */
export interface LevelDataInteractives {
	interactives: LevelInteractive[];
	/** function areas that hide entities by type (`HideEntityByTypeParams`) */
	hideByTypeAreas: number;
	/** named places from region-toast function areas (`SceneToastUIData`) */
	places?: LevelPlace[];
}

const HIDE_BY_TYPE_AREA = 'Beyond_Gameplay_LevelFunctionAreaData_HideEntityByTypeParamsForMemoryPack';

const atomScratch = new DataView(new ArrayBuffer(4));

/**
 * @param bits a 32-bit float's IEEE-754 bits stored in the low half of a 64-bit interactive atom
 * @returns the float value
 */
export const atomFloat = (bits: bigint): number => {
	atomScratch.setUint32(0, Number(BigInt.asUintN(32, bits)));
	return atomScratch.getFloat32(0);
};

/**
 * @param bits a signed 32-bit integer stored in the low half of a 64-bit interactive atom
 * @returns the integer value
 */
export const atomInt = (bits: bigint): number => Number(BigInt.asIntN(32, bits));

/**
 * @param value a decoded `ParamKeyValue`
 * @returns it as an {@link InteractiveParam}
 * @throws {FormatError} if it isn't one
 */
export const interactiveParamFromValue = (value: MemoryPackValue): InteractiveParam => {
	const pair = asMemoryPackObject(value, 'interactive parameter');
	const inner = asMemoryPackObject(pair.value, 'interactive parameter value');
	if (typeof pair.key !== 'string' || typeof inner.type !== 'number' || !Array.isArray(inner.valueArray)) {
		throw new FormatError('invalid interactive parameter');
	}
	return {
		key: pair.key,
		type: inner.type,
		values: inner.valueArray.map((atom) => {
			const { valueBit64, valueString } = asMemoryPackObject(atom, 'interactive parameter atom');
			if (typeof valueBit64 !== 'string' && typeof valueBit64 !== 'number') {
				throw new FormatError('invalid interactive parameter bits');
			}
			return {
				bits: BigInt.asUintN(64, BigInt(valueBit64)),
				text: typeof valueString === 'string' ? valueString : null,
			};
		}),
	};
};

/**
 * converts an interactive the MemoryPack schema decoded (`LevelInteractiveData`) into a placement
 *
 * @param value the decoded row
 * @param id the id to give it: its `levelLogicId` for LevelData placements, or a synthetic id for a script's
 *   own interactive (whose `levelLogicId` is 0 and which the script names by slot instead)
 * @returns the placement
 * @throws {FormatError} if the row lacks a field a placement needs
 */
export const levelInteractiveFromValue = (value: MemoryPackValue, id: bigint): LevelInteractive => {
	const row = asMemoryPackObject(value, 'interactive row');
	if (typeof row.entityDataIdKey !== 'string' || typeof row.createState !== 'number') {
		throw new FormatError('invalid interactive row');
	}
	const componentProperties = new Map<number, InteractiveParam[]>();
	for (const pair of Array.isArray(row.componentProperties) ? row.componentProperties : []) {
		if (!Array.isArray(pair) || typeof pair[0] !== 'number' || !Array.isArray(pair[1])) {
			throw new FormatError('invalid interactive component properties');
		}
		componentProperties.set(pair[0], pair[1].map(interactiveParamFromValue));
	}
	return {
		id,
		template: row.entityDataIdKey,
		createState: row.createState,
		position: asMemoryPackVec3(row.position, 'interactive position'),
		rotation: asMemoryPackVec3(row.rotation, 'interactive rotation'),
		scale: asMemoryPackVec3(row.scale, 'interactive scale'),
		modelScale: typeof row.modelScale === 'number' ? row.modelScale : 0,
		isLocked: row.isLocked === true,
		properties: (Array.isArray(row.properties) ? row.properties : []).map(interactiveParamFromValue),
		componentProperties,
	};
};

/**
 * reads the interactive placements and unapplied hide-by-type function areas of a LevelData the MemoryPack
 * schema decoded (`LevelDataForMemoryPack`)
 *
 * @param levelData the decoded LevelData (at least `interactives`, plus `functionArea` when counting
 *   hide-by-type areas)
 * @returns the placements and hide-by-type area count
 * @throws {FormatError} if a row lacks a field a placement needs
 */
export const readLevelDataInteractives = (levelData: MemoryPackValue): LevelDataInteractives => {
	const data = asMemoryPackObject(levelData, 'level data');
	const interactives: LevelInteractive[] = [];
	if (Array.isArray(data.interactives)) {
		for (const value of data.interactives) {
			const row = asMemoryPackObject(value, 'interactive row');
			if (typeof row.levelLogicId !== 'string' && typeof row.levelLogicId !== 'number') {
				throw new FormatError('invalid interactive logic id');
			}
			interactives.push(levelInteractiveFromValue(row, BigInt(row.levelLogicId)));
		}
	}
	let hideByTypeAreas = 0;
	const places: LevelPlace[] = [];
	if (data.functionArea !== null && data.functionArea !== undefined) {
		const area = asMemoryPackObject(data.functionArea, 'function area');
		const ranges = Array.isArray(area.ranges) ? area.ranges : [];
		if (Array.isArray(area.specificDatas)) {
			for (const [i, entry] of area.specificDatas.entries()) {
				if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
					continue;
				}
				const obj = entry as Record<string, MemoryPackValue>;
				if (obj.$type === HIDE_BY_TYPE_AREA) {
					hideByTypeAreas++;
				} else if (obj.$type === 'Beyond_Gameplay_LevelFunctionAreaData_SceneToastUIDataForMemoryPack') {
					const priority = typeof obj.priority === 'number' ? obj.priority : 0;
					const subTitle = obj.subTitle;
					const subTitleKey =
						subTitle !== null &&
						typeof subTitle === 'object' &&
						!Array.isArray(subTitle) &&
						typeof subTitle.key === 'string'
							? subTitle.key
							: '';
					const range = ranges[i];
					if (
						priority >= 1 &&
						subTitleKey.length > 0 &&
						range !== null &&
						typeof range === 'object' &&
						!Array.isArray(range)
					) {
						const c = range.m_center;
						const s = range.m_size;
						if (
							Array.isArray(c) &&
							c.length >= 3 &&
							typeof c[0] === 'number' &&
							typeof c[1] === 'number' &&
							typeof c[2] === 'number'
						) {
							const sx = Array.isArray(s) && typeof s[0] === 'number' ? s[0] : 40;
							const sy = Array.isArray(s) && typeof s[1] === 'number' ? s[1] : 20;
							const sz = Array.isArray(s) && typeof s[2] === 'number' ? s[2] : 40;
							places.push({
								subTitleKey,
								center: [c[0], c[1], c[2]],
								radius: Math.hypot(sx, sy, sz) * 0.5,
								priority,
							});
						}
					}
				}
			}
		}
	}
	return { interactives, hideByTypeAreas, ...(places.length > 0 ? { places } : {}) };
};
