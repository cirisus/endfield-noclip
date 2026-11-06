import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	isObject,
	numberField,
	objectField,
	stringField,
} from '@endfield-noclip/formats/unity/values';

const reference = (value: unknown): bigint => {
	if (!isObject(value) || typeof value.rid !== 'bigint') {
		throw new FormatError('invalid character component reference');
	}
	return value.rid;
};

/**
 * @param asset decoded character asset with managed reference records
 * @returns the active template's movement inputs, excluding unreferenced component records
 * @throws {FormatError} for missing/ambiguous references or invalid capsule dimensions
 */
export const characterMovement = (asset: TypeTreeObject) => {
	const records = new Map<bigint, TypeTreeObject>();
	for (const value of arrayField(objectField(asset, 'references'), 'RefIds')) {
		const id = reference(value);
		if (!isObject(value) || records.has(id)) {
			throw new FormatError('duplicate character reference');
		}
		records.set(id, value);
	}
	const root = records.get(reference(asset.data));
	if (!root || stringField(objectField(root, 'type'), 'class') !== 'CharacterTemplateData') {
		throw new FormatError('missing character template');
	}
	const template = objectField(root, 'data');
	const movement = arrayField(template, 'componentList').flatMap((value) => {
		const record = records.get(reference(value));
		if (!record) {
			throw new FormatError('missing character component');
		}
		const type = objectField(record, 'type');
		return type.class === 'CharacterMovementComponentData' && type.ns === 'Beyond.Gameplay.Core'
			? [objectField(record, 'data')]
			: [];
	});
	if (movement.length !== 1) {
		throw new FormatError('expected one character movement component');
	}
	const shape = objectField(movement[0], 'proxyShape');
	const radius = numberField(shape, 'radius'),
		height = numberField(shape, 'height');
	if (!Number.isFinite(radius) || !Number.isFinite(height) || radius <= 0 || height < 2 * radius) {
		throw new FormatError('invalid character capsule');
	}
	return {
		id: stringField(template, 'id'),
		bodyType: objectField(template, 'bodyType'),
		proxyShape: { radius, height },
		movement: objectField(movement[0], 'movementData'),
	};
};

/**
 * @param characters decoded character movement records
 * @returns the most frequent authored capsule; ties prefer larger radius, then larger height
 * @throws {FormatError} when no character capsules are available
 */
export const commonCapsule = (characters: readonly ReturnType<typeof characterMovement>[]) => {
	const counts = new Map<string, { radius: number; height: number; count: number }>();
	for (const {
		proxyShape: { radius, height },
	} of characters) {
		const key = `${radius}/${height}`,
			previous = counts.get(key);
		counts.set(key, { radius, height, count: (previous?.count ?? 0) + 1 });
	}
	const selected = [...counts.values()].toSorted(
		(a, b) => b.count - a.count || b.radius - a.radius || b.height - a.height,
	)[0];
	if (!selected) {
		throw new FormatError('no character capsules for default profile');
	}
	return { radius: selected.radius, height: selected.height };
};
