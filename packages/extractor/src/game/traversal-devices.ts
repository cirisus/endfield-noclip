import { isObject } from '@endfield-noclip/formats/unity/values';

type Vec3 = [number, number, number];

const reference = (value: unknown): string => {
	if (
		typeof value !== 'string' &&
		typeof value !== 'bigint' &&
		!(typeof value === 'number' && Number.isSafeInteger(value))
	) {
		throw new Error('invalid device reference');
	}
	const id = String(value);
	if (!/^[1-9]\d*$/.test(id)) {
		throw new Error('invalid device reference id');
	}
	return id;
};

const vector = (value: unknown): Vec3 => {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		!value.every((v) => typeof v === 'number' && Number.isFinite(v))
	) {
		throw new Error('invalid traversal device transform');
	}
	return [value[0], value[1], value[2]];
};

/** @param template placed template id @returns the supported authored device family, or null */
const traversalKind = (template: string): 'rope' | 'launch' | 'accelerate' | null => {
	if (template.startsWith('int_rope_port')) {
		return 'rope';
	}
	if (template.startsWith('int_jumpmachine')) {
		return 'launch';
	}
	if (template === 'int_accelerate_buff') {
		return 'accelerate';
	}
	return null;
};

/**
 * retains parameter scopes instead of guessing runtime override order or treating a default state as the
 * player's unlock state. device pivots are not grounded endpoints.
 *
 * @param value decoded LevelInteractiveData
 * @param level owning level
 * @returns a selected device or null
 * @throws on malformed selected placements or ambiguous rope target references
 */
export const traversalDevice = (value: unknown, level: string) => {
	if (!isObject(value) || typeof value.entityDataIdKey !== 'string') {
		throw new Error('invalid interactive placement');
	}
	const kind = traversalKind(value.entityDataIdKey);
	if (!kind) {
		return null;
	}
	const id = reference(value.levelLogicId);
	if (!Array.isArray(value.properties) || !Array.isArray(value.componentProperties)) {
		throw new Error('invalid traversal device');
	}
	let target: string | null = null;
	if (kind === 'rope') {
		const targets = value.properties.filter((p) => isObject(p) && p.key === 'target');
		if (targets.length > 1) {
			throw new Error('ambiguous rope target');
		}
		if (targets.length === 1) {
			const property = targets[0];
			const parameter = isObject(property) && isObject(property.value) ? property.value : null;
			const atoms = parameter?.valueArray;
			if (parameter?.type !== 13 || !Array.isArray(atoms) || atoms.length !== 1 || !isObject(atoms[0])) {
				throw new Error('invalid rope target');
			}
			target = reference(atoms[0].valueBit64);
		}
	}
	return {
		id,
		kind,
		level,
		template: value.entityDataIdKey,
		position: vector(value.position),
		rotation: vector(value.rotation),
		scale: vector(value.scale),
		target,
		availability: 'unknown' as const,
		motionValidation: 'unresolved' as const,
		requiresGroundProjection: true,
		placement: {
			createState: value.createState,
			isLocked: value.isLocked,
			progressLockCondition: value.progressLockCondition,
			properties: value.properties,
			componentProperties: value.componentProperties,
			mapProperties: value.mapProperties,
			globalProperties: value.globalProperties,
		},
	};
};

type Device = NonNullable<ReturnType<typeof traversalDevice>>;

/**
 * pairs only reciprocal authored references, never nearby or vertically aligned markers.
 *
 * @param devices selected placements from the exported scene
 * @returns candidate rope pairs and endpoints whose targets remain unconfirmed
 * @throws on duplicate ids
 */
export const ropePairs = (devices: readonly Device[]) => {
	const byId = new Map<string, Device>();
	for (const device of devices) {
		if (byId.has(device.id)) {
			throw new Error('duplicate traversal device id');
		}
		byId.set(device.id, device);
	}
	const pairs = [],
		unpaired = [];
	for (const device of devices) {
		if (device.kind !== 'rope') {
			continue;
		}
		const target = device.target === null ? undefined : byId.get(device.target);
		if (
			!target ||
			target.kind !== 'rope' ||
			target.target !== device.id ||
			target.level !== device.level ||
			target.position[1] === device.position[1]
		) {
			unpaired.push(device.id);
			continue;
		}
		if (device.position[1] > target.position[1]) {
			pairs.push({
				top: device.id,
				bottom: target.id,
				ascent: 'rope',
				descent: 'drop',
				availability: 'unknown',
				motionValidation: 'unresolved',
				requiresGroundProjection: true,
			});
		}
	}
	return { pairs, unpaired };
};
