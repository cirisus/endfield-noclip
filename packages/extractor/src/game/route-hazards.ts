import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
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

/**
 * @param data current metadata-decoded level data
 * @returns authored repatriation volumes with conservative world bounds and unresolved activation
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
		return [
			{
				kind: 'repatriation',
				slot,
				state: 'unknown',
				min: center.map((v, i) => v - size[i] / 2),
				max: center.map((v, i) => v + size[i] / 2),
				// preserve the precise authored shape for a future state/volume resolver. until then,
				// using the bounds may reject safe routes but cannot turn a reset zone into a landing.
				shape: value,
				payload: specific ?? null,
				conditions: arrayField(area, 'functionAreaConditions'),
			},
		];
	});
};
