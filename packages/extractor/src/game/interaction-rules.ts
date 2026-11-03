import { trsMatrix, transformPoint, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import { isObject } from '@endfield-noclip/formats/unity/values';

type Source = { buildGuid: string; contentHash: string; path: string };

const integer = (value: unknown): bigint => {
	if (typeof value === 'bigint') {
		return value;
	}
	if (typeof value === 'number' && Number.isSafeInteger(value)) {
		return BigInt(value);
	}
	if (typeof value === 'string' && /^-?\d+$/.test(value)) {
		return BigInt(value);
	}
	throw new Error('invalid interaction parameter atom');
};

const float = (value: bigint) => {
	const data = new DataView(new ArrayBuffer(4));
	data.setUint32(0, Number(BigInt.asUintN(32, value)), true);
	const result = data.getFloat32(0, true);
	if (!Number.isFinite(result)) {
		throw new Error('non-finite interaction parameter');
	}
	return result;
};

/**
 * reads the authored base trigger independently of per-instance overrides and collision policy. offsets and
 * angles remain in the interactive's local frame. trigger radius is retained as an authored collider
 * parameter; it is not substituted for a player-foot collection distance.
 *
 * @param template decoded interactive template, from current MemoryPack or authored JSON
 * @param source matching build identity and template path retained by the caller
 * @returns base trigger and directional-check parameters, or null when the component is absent
 * @throws for ambiguous components, missing fields, incompatible parameter types or malformed values
 */
export const interactionRules = (template: unknown, source: Source) => {
	if (
		![source.buildGuid, source.contentHash, source.path].every(
			(value) => typeof value === 'string' && value.length,
		)
	) {
		throw new Error('interaction source identity required');
	}
	if (!isObject(template) || !Array.isArray(template.componentList)) {
		throw new Error('invalid interaction template');
	}
	const components = template.componentList.filter(
		(component) =>
			isObject(component) &&
			(component.$type === 'Beyond_Gameplay_Core_TriggerObserverComponentDataForMemoryPack' ||
				component.$type === 'Beyond.Gameplay.Core.TriggerObserverComponentData, Gameplay.Beyond'),
	);
	if (components.length === 0) {
		return null;
	}
	if (components.length !== 1 || !isObject(components[0]) || !Array.isArray(components[0].propertyList)) {
		throw new Error('ambiguous interaction trigger');
	}
	const properties = new Map<string, unknown>();
	for (const property of components[0].propertyList) {
		if (!isObject(property) || typeof property.key !== 'string' || properties.has(property.key)) {
			throw new Error('invalid interaction trigger property');
		}
		properties.set(property.key, property.value);
	}
	const atoms = (key: string, numericType: number, namedType: string, count: number) => {
		const value = properties.get(key);
		if (
			!isObject(value) ||
			(value.type !== numericType && value.type !== namedType) ||
			!Array.isArray(value.valueArray) ||
			value.valueArray.length !== count
		) {
			throw new Error(`invalid interaction parameter ${key}`);
		}
		return value.valueArray.map((atom) => {
			if (!isObject(atom)) {
				throw new Error('invalid interaction parameter atom');
			}
			return integer(atom.valueBit64);
		});
	};

	const scalar = (key: string) => float(atoms(key, 5, 'Float', 1)[0]);
	const vector = (key: string): [number, number, number] => {
		const values = atoms(key, 11, 'Vector3', 3).map(float);
		return [values[0], values[1], values[2]];
	};
	const boolean = (key: string) => {
		const value = atoms(key, 1, 'Bool', 1)[0];
		if (value !== 0n && value !== 1n) {
			throw new Error('invalid interaction boolean');
		}
		return value === 1n;
	};
	const shape = Number(atoms('shape', 3, 'Int', 1)[0]);
	const trigger = { shape, radius: scalar('radius'), center: vector('center'), size: vector('size') };
	const direction = {
		enabled: boolean('interactive_direction_check'),
		offset: vector('check_area_offset'),
		radius: scalar('check_area_radius'),
		height: scalar('check_area_height'),
		angle: scalar('check_angle'),
		angleOffset: scalar('check_angle_offset'),
		playerDirectionCheck: boolean('player_direction_check'),
	};
	if (
		!Number.isSafeInteger(shape) ||
		shape < 0 ||
		trigger.radius < 0 ||
		trigger.size.some((value) => value < 0) ||
		direction.radius < 0 ||
		direction.height < 0 ||
		direction.angle < 0 ||
		direction.angle > 360
	) {
		throw new Error('invalid interaction trigger dimensions');
	}
	return {
		version: 1,
		source: { ...source },
		scope: 'base-template' as const,
		trigger,
		direction,
		inTriggerVolumePerformance: boolean('in_trigger_volume_performance'),
		unresolved: ['variant-and-placement-overrides', 'player-trigger-overlap', 'runtime-line-of-sight'],
	};
};

type PlacedRules = Omit<NonNullable<ReturnType<typeof interactionRules>>, 'scope'> & {
	scope: 'placed-effective';
};

const triggerKeys = new Set([
	'shape',
	'radius',
	'center',
	'size',
	'interactive_direction_check',
	'check_area_offset',
	'check_area_radius',
	'check_area_height',
	'check_angle',
	'check_angle_offset',
	'player_direction_check',
	'in_trigger_volume_performance',
]);

const pointVector = (value: unknown): [number, number, number] => {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		!value.every((item) => typeof item === 'number' && Number.isFinite(item))
	) {
		throw new Error('invalid interaction point transform');
	}
	return [Number(value[0]), Number(value[1]), Number(value[2])];
};
const overrideList = (value: unknown): unknown[] => {
	if (value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error('invalid interaction override scope');
	}
	return value;
};

const parameterKind = (type: unknown) => {
	switch (type) {
		case 1:
		case 'Bool': {
			return 'boolean';
		}
		case 3:
		case 'Int': {
			return 'integer';
		}
		case 5:
		case 'Float': {
			return 'float';
		}
		case 11:
		case 'Vector3': {
			return 'vector';
		}
		default: {
			return null;
		}
	}
};
const compatibleParameter = (a: unknown, b: unknown) =>
	isObject(a) &&
	isObject(b) &&
	parameterKind(a.type) !== null &&
	parameterKind(a.type) === parameterKind(b.type) &&
	Array.isArray(a.valueArray) &&
	Array.isArray(b.valueArray) &&
	a.valueArray.length === b.valueArray.length;

const sameParameter = (a: unknown, b: unknown) => {
	if (
		!isObject(a) ||
		!isObject(b) ||
		!compatibleParameter(a, b) ||
		!Array.isArray(a.valueArray) ||
		!Array.isArray(b.valueArray) ||
		a.valueArray.length !== b.valueArray.length
	) {
		return false;
	}
	const firstValues = a.valueArray,
		secondValues = b.valueArray;
	try {
		return firstValues.every((atom, index) => {
			const other = secondValues[index];
			if (!isObject(atom) || !isObject(other)) {
				return false;
			}
			const first = integer(atom.valueBit64),
				second = integer(other.valueBit64);
			if (a.type === 5 || a.type === 11 || a.type === 'Float' || a.type === 'Vector3') {
				return float(first) === float(second);
			}
			return first === second;
		});
	} catch {
		return false;
	}
};

/**
 * resolves direct authored trigger properties in base, selected-variant, placement order. selected variants
 * replace matching base keys; placement component type zero overwrites or adds trigger keys.
 * referenced/global expressions remain unresolved and all source scopes are retained.
 *
 * @param placement decoded level interactive
 * @param level owning level identifier
 * @param template decoded base template, or null when unavailable
 * @param rules decoded base interaction rules, or null without a supported trigger
 * @returns identity, transform, selected override scopes and base-rule compatibility
 * @throws for malformed placement identity, transforms or override containers
 */
export const interactionPoint = (
	placement: unknown,
	level: string,
	template: unknown,
	rules: ReturnType<typeof interactionRules>,
) => {
	if (
		!isObject(placement) ||
		typeof placement.entityDataIdKey !== 'string' ||
		typeof placement.levelLogicId !== 'string' ||
		!/^[1-9]\d*$/.test(placement.levelLogicId) ||
		!level.length
	) {
		throw new Error('invalid interaction point identity');
	}

	const relevant = (properties: unknown) =>
		overrideList(properties).filter((property) => {
			if (!isObject(property) || typeof property.key !== 'string') {
				throw new Error('invalid interaction override property');
			}
			return triggerKeys.has(property.key);
		});
	const name = placement.entityDataIdKey;
	const variants = isObject(template) ? overrideList(template.templateVariant) : [];
	const selected = variants.find((entry) => Array.isArray(entry) && entry[0] === name);
	const variant = Array.isArray(selected) && isObject(selected[1]) ? selected[1] : null;
	const baseId = isObject(template) && typeof template.id === 'string' ? template.id : null;
	const variantMissing = baseId !== null && baseId !== name && variant === null;
	const componentOverrides = overrideList(placement.componentProperties).filter((entry) => {
		if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
			throw new Error('invalid interaction component override');
		}
		return entry[0] === 0;
	});
	const variantComponents = variant
		? overrideList(variant.componentDiffProperties).filter((entry) => {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
					throw new Error('invalid interaction variant override');
				}
				return entry[0] === 'Comp_TriggerObserver';
			})
		: [];
	const overrides = {
		placement: {
			properties: overrideList(placement.properties),
			components: overrideList(placement.componentProperties),
			map: overrideList(placement.mapProperties),
			global: overrideList(placement.globalProperties),
		},
		variant,
		triggerCandidates: {
			properties: relevant(placement.properties),
			components: componentOverrides,
			map: relevant(placement.mapProperties),
			global: relevant(placement.globalProperties),
			variantProperties: variant ? relevant(variant.diffProperties) : [],
			variantComponents,
		},
	};
	const baseProperties = new Map<string, unknown>();
	if (isObject(template) && Array.isArray(template.componentList)) {
		for (const component of template.componentList) {
			if (
				!isObject(component) ||
				typeof component.$type !== 'string' ||
				!component.$type.includes('TriggerObserverComponentData') ||
				!Array.isArray(component.propertyList)
			) {
				continue;
			}
			for (const property of component.propertyList) {
				if (isObject(property) && typeof property.key === 'string') {
					baseProperties.set(property.key, property.value);
				}
			}
		}
	}
	const hasChanges = (properties: unknown[]) =>
		relevant(properties).some(
			(property) =>
				!isObject(property) ||
				typeof property.key !== 'string' ||
				!sameParameter(property.value, baseProperties.get(property.key)),
		);
	const unresolved: string[] = [];
	if (!template) {
		unresolved.push('template-unavailable');
	}
	if (variantMissing) {
		unresolved.push('variant-unavailable');
	}
	if (!rules) {
		unresolved.push('trigger-rules-unavailable');
	}
	if (
		hasChanges(overrides.triggerCandidates.properties) ||
		hasChanges(overrides.triggerCandidates.map) ||
		hasChanges(overrides.triggerCandidates.global) ||
		hasChanges(overrides.triggerCandidates.variantProperties)
	) {
		unresolved.push('referenced-global-parameter-unresolved');
	}
	const effectiveProperties = new Map(baseProperties);
	const applied: { scope: string; key: string }[] = [];
	const apply = (properties: unknown[], scope: 'variant' | 'placement') => {
		for (const property of relevant(properties)) {
			if (!isObject(property) || typeof property.key !== 'string') {
				continue;
			}
			if (scope === 'variant' && !effectiveProperties.has(property.key)) {
				continue;
			}
			if (
				effectiveProperties.has(property.key) &&
				!compatibleParameter(property.value, effectiveProperties.get(property.key))
			) {
				unresolved.push('typed-component-property-unresolved');
				continue;
			}
			effectiveProperties.set(property.key, property.value);
			applied.push({ scope, key: property.key });
		}
	};
	for (const entry of variantComponents) {
		if (!Array.isArray(entry) || !isObject(entry[1]) || !Array.isArray(entry[1].value)) {
			unresolved.push('invalid-variant-component-properties');
			continue;
		}
		apply(entry[1].value, 'variant');
	}
	for (const entry of componentOverrides) {
		if (Array.isArray(entry)) {
			apply(overrideList(entry[1]), 'placement');
		}
	}
	let canonical: ReturnType<typeof interactionRules> | PlacedRules = rules;
	if (rules && !unresolved.length) {
		try {
			const merged = interactionRules(
				{
					componentList: [
						{
							$type: 'Beyond_Gameplay_Core_TriggerObserverComponentDataForMemoryPack',
							propertyList: [...effectiveProperties].map(([key, value]) => ({ key, value })),
						},
					],
				},
				rules.source,
			);
			canonical = merged
				? { ...merged, scope: 'placed-effective', unresolved: ['runtime-line-of-sight', 'runtime-state'] }
				: null;
		} catch {
			unresolved.push('typed-component-property-unresolved');
			canonical = null;
		}
	}
	if (unresolved.length) {
		canonical = null;
	}
	const changed = [...effectiveProperties].some(
		([key, value]) => !sameParameter(value, baseProperties.get(key)),
	);
	const result = {
		id: placement.levelLogicId,
		level,
		template: name,
		baseTemplate: baseId,
		position: pointVector(placement.position),
		rotation: pointVector(placement.rotation),
		scale: pointVector(placement.scale),
		rules: canonical,
		baseRules: rules,
		overrides,
		effective: {
			status: unresolved.length ? 'unresolved' : changed ? 'overrides-applied' : 'base-rule-compatible',
			unresolved,
			applied,
			order: ['base', 'selected-variant', 'placement'],
		},
		conditions: {
			createState: placement.createState,
			isLocked: placement.isLocked,
			progressLockCondition: placement.progressLockCondition,
		},
		availability: 'unknown' as const,
	};
	const navigation = interactionGoal(result);
	return { ...result, navigationGoal: navigation.goal, navigationUnresolved: navigation.unresolved };
};

/**
 * converts supported authored sphere triggers into the normal-channel ground-goal model. the checked probe is
 * 0.4 m above the player's root and has radius 0.5 m. entity scale applies to the primary sphere, while the
 * independent direction gate retains its authored dimensions. runtime line-of-sight and unlock predicates
 * remain caller-owned conditions.
 *
 * @param point placed effective rules and their authored transform
 * @returns a source-bound foot-coordinate goal or explicit unsupported conditions
 */
export const interactionGoal = (point: {
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
	rules: ReturnType<typeof interactionRules> | PlacedRules;
	effective: { status: string; unresolved: string[] };
}) => {
	pointVector(point.position);
	pointVector(point.rotation);
	pointVector(point.scale);
	const unresolved = [...point.effective.unresolved];
	if (point.effective.status === 'unresolved' && !unresolved.length) {
		unresolved.push('effective-rules-unresolved');
	}
	const rules = point.rules;
	if (!rules) {
		return { goal: null, unresolved: [...unresolved, 'effective-trigger-unavailable'] };
	}
	if (rules.trigger.shape !== 2) {
		unresolved.push('unsupported-trigger-shape');
	}
	if (point.rotation[0] !== 0 || point.rotation[2] !== 0) {
		unresolved.push('tilted-interaction-transform');
	}
	if (point.scale.some((value) => !Number.isFinite(value) || value <= 0)) {
		unresolved.push('unsupported-interaction-scale');
	}
	if (rules.direction.playerDirectionCheck) {
		unresolved.push('player-facing-requirement-unresolved');
	}
	const rotation = unityEulerQuaternion(point.rotation);
	const center = transformPoint(trsMatrix(point.position, rotation, point.scale), rules.trigger.center);
	let radius = rules.trigger.radius * Math.max(...point.scale) + 0.5;
	let maxVertical: number | undefined;
	let facing: [number, number, number] | undefined;
	let halfAngle: number | undefined;
	if (rules.direction.enabled) {
		const localCenter = rules.trigger.center.map((value, axis) => value + rules.direction.offset[axis]);
		const directionCenter = transformPoint(trsMatrix(point.position, rotation, [1, 1, 1]), localCenter);
		if (Math.hypot(...center.map((value, axis) => value - directionCenter[axis])) > 1e-4) {
			unresolved.push('different-trigger-and-direction-centers');
		}
		if (rules.direction.angle <= 0 || (rules.direction.angle > 180 && rules.direction.angle !== 360)) {
			unresolved.push('unsupported-direction-angle');
		}
		radius = Math.min(radius, rules.direction.radius + 0.5);
		maxVertical = rules.direction.height;
		if (rules.direction.angle < 360) {
			const forward = transformPoint(
				trsMatrix(
					[0, 0, 0],
					unityEulerQuaternion([0, point.rotation[1] + rules.direction.angleOffset, 0]),
					[1, 1, 1],
				),
				[0, 0, 1],
			);
			facing = [forward[0], 0, forward[2]];
			halfAngle = rules.direction.angle / 2;
		}
	}
	if (unresolved.length) {
		return { goal: null, unresolved };
	}
	return {
		goal: {
			position: [center[0], center[1] - 0.4, center[2]] as [number, number, number],
			interaction: {
				radius,
				...(maxVertical === undefined ? {} : { maxVertical }),
				...(facing ? { facing, halfAngle } : {}),
			},
			source: { ...rules.source },
			model: 'normal-trigger-probe-v1',
		},
		unresolved,
	};
};
