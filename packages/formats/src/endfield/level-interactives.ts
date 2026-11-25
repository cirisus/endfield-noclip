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

/** the interactives and function-area summary read from a decoded LevelData */
export interface LevelDataInteractives {
	interactives: LevelInteractive[];
	/** function areas that hide entities by type (`HideEntityByTypeParams`) */
	hideByTypeAreas: number;
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
	if (data.functionArea !== null && data.functionArea !== undefined) {
		const area = asMemoryPackObject(data.functionArea, 'function area');
		if (Array.isArray(area.specificDatas)) {
			for (const entry of area.specificDatas) {
				if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
					if (entry.$type === HIDE_BY_TYPE_AREA) {
						hideByTypeAreas++;
					}
				}
			}
		}
	}
	return { interactives, hideByTypeAreas };
};
