import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { trsMatrix, transformPoint, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { arrayField, isObject, objectField, numberField } from '@endfield-noclip/formats/unity/values';

const vector = (value: unknown): [number, number, number] => {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		!value.every((v) => typeof v === 'number' && Number.isFinite(v))
	) {
		throw new FormatError('invalid route hazard vector');
	}
	return [Number(value[0]), Number(value[1]), Number(value[2])];
};

const polygonOf = (shape: TypeTreeObject, min: number[], max: number[]) => {
	if (shape.shapeType !== 3) {
		return undefined;
	}
	const rotation = vector(shape.euler),
		offset = vector(shape.offset);
	// tilted or offset prisms need their full shape semantics; keep their conservative bounds.
	if (rotation[0] !== 0 || rotation[2] !== 0 || offset.some((v) => v !== 0) || shape.bufferDistance !== 0) {
		return undefined;
	}
	const matrix = trsMatrix(vector(shape.postion), unityEulerQuaternion(rotation), [1, 1, 1]);
	const polygon = arrayField(shape, 'posList').map((p): [number, number] => {
		if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
			throw new FormatError('invalid hazard polygon');
		}
		const world = transformPoint(matrix, [Number(p[0]), 0, Number(p[1])]);
		return [world[0], world[2]];
	});
	if (
		polygon.length < 3 ||
		[0, 1].some(
			(i) =>
				Math.abs(Math.min(...polygon.map((p) => p[i])) - min[i * 2]) > 0.001 ||
				Math.abs(Math.max(...polygon.map((p) => p[i])) - max[i * 2]) > 0.001,
		)
	) {
		throw new FormatError('hazard polygon disagrees with exported bounds');
	}
	return polygon;
};

/**
 * @param data current metadata-decoded level data
 * @returns authored repatriation volumes with conservative world bounds and source-resolved activation
 * @throws {FormatError} if a hazard cannot be mapped to its bounds or specific payload
 */
export const routeHazards = (data: TypeTreeObject) => {
	const area = objectField(data, 'functionArea');
	const bases = arrayField(area, 'baseData'),
		ranges = arrayField(area, 'ranges'),
		specifics = arrayField(area, 'specificDatas');
	if (bases.length !== ranges.length) {
		throw new FormatError('route hazard range count mismatch');
	}
	return bases.flatMap((value, slot) => {
		if (!isObject(value)) {
			throw new FormatError('invalid function area');
		}
		const index = numberField(value, 'index');
		if (!Number.isInteger(index)) {
			throw new FormatError('invalid function area payload index');
		}
		const specific = specifics[index];
		const repatriates =
			isObject(specific) &&
			specific.$type === 'Beyond_Gameplay_LevelFunctionAreaData_RepatriateZoneDataForMemoryPack';
		const temporary = numberField(value, 'functionType') === 15 && index === -1;
		// temporary reset zones carry only their base shape; ordinary reset zones require a payload.
		if ([1, 15].includes(numberField(value, 'functionType')) && !repatriates && !temporary) {
			throw new FormatError('missing repatriation payload');
		}
		if (!repatriates && !temporary) {
			return [];
		}
		const range = ranges[slot];
		if (!isObject(range)) {
			throw new FormatError('missing route hazard bounds');
		}
		const center = vector(range.m_center),
			size = vector(range.m_size);
		if (size.some((v) => v < 0)) {
			throw new FormatError('negative route hazard bounds');
		}
		const min = center.map((v, i) => v - size[i] / 2),
			max = center.map((v, i) => v + size[i] / 2);
		// the client enables unaddressed areas directly. their defaultOff field
		// belongs to the addressed-area branch and cannot disable these reset zones.
		const state = value.uniqueId === 0n && value.hasCondition === false ? 'active' : 'unknown';
		return [
			{
				kind: 'repatriation',
				slot,
				state,
				min,
				max,
				polygon: polygonOf(value, min, max),
				// unsupported shapes retain conservative bounds and all inputs for a later resolver.
				shape: value,
				payload: specific ?? null,
				conditions: arrayField(area, 'functionAreaConditions'),
			},
		];
	});
};
