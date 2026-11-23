import { FormatError } from '../binary/binary-reader.ts';
import type { AttributeReader, TypeDefinition } from '../il2cpp/metadata.ts';
import type { Il2CppRuntime, Il2CppTypeRef } from '../il2cpp/registration.ts';

// MemoryPack-serialized game data (level scripts, interactive templates, LevelData, view-state controllers).
// the schema is read from the user's install (IL2CPP metadata and binary), never stored in this repo.
// wire layout and custom formatters are in docs/game-data/containers.md#memorypack.

/** a decoded value: objects carry their wrapper's name as `$type`; 64-bit integers are decimal strings */
export type MemoryPackValue =
	| null
	| boolean
	| number
	| string
	| MemoryPackValue[]
	| { [key: string]: MemoryPackValue };

/** a decoded object: a wrapper's members by name, and its `$type` */
export type MemoryPackObject = { [key: string]: MemoryPackValue };

/**
 * @param value a decoded value, or a missing member
 * @returns whether it's an object
 */
export const isMemoryPackObject = (value: MemoryPackValue | undefined): value is MemoryPackObject =>
	value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

/**
 * @param value a decoded value, or a missing member
 * @param what label for the error message
 * @returns the value as an object
 * @throws {FormatError} if it isn't an object
 */
export const asMemoryPackObject = (value: MemoryPackValue | undefined, what: string): MemoryPackObject => {
	if (!isMemoryPackObject(value)) {
		throw new FormatError(`invalid ${what}`);
	}
	return value;
};

/**
 * @param value a decoded value, or a missing member
 * @param what label for the error message
 * @returns the value as a number
 * @throws {FormatError} if it isn't a number
 */
export const asMemoryPackNumber = (value: MemoryPackValue | undefined, what: string): number => {
	if (typeof value !== 'number') {
		throw new FormatError(`invalid ${what}`);
	}
	return value;
};

/**
 * @param value a decoded value, or a missing member
 * @param what label for the error message
 * @returns a 3-vector from either a `Vector3` array or a `Unity.Mathematics.float3` object
 * @throws {FormatError} if it isn't a 3-vector of numbers
 */
export const asMemoryPackVec3 = (
	value: MemoryPackValue | undefined,
	what: string,
): [number, number, number] => {
	if (Array.isArray(value)) {
		if (value.length !== 3) {
			throw new FormatError(`invalid ${what}`);
		}
		return [
			asMemoryPackNumber(value[0], what),
			asMemoryPackNumber(value[1], what),
			asMemoryPackNumber(value[2], what),
		];
	}
	// Unity.Mathematics float3
	const { x, y, z } = asMemoryPackObject(value, what);
	return [asMemoryPackNumber(x, what), asMemoryPackNumber(y, what), asMemoryPackNumber(z, what)];
};

/**
 * @param value a decoded value, or a missing member
 * @returns its `$type` wrapper name, or `undefined` if it isn't a typed object
 */
export const memoryPackType = (value: MemoryPackValue | undefined): string | undefined =>
	isMemoryPackObject(value) && typeof value.$type === 'string' ? value.$type : undefined;

/**
 * @param entries a decoded `Dictionary` / `SerializeFieldDictionary` (`[key, value][]`)
 * @param key the key to find
 * @returns the first matching value, or `undefined` if absent
 */
export const memoryPackDictGet = (
	entries: MemoryPackValue | undefined,
	key: MemoryPackValue,
): MemoryPackValue | undefined => {
	if (!Array.isArray(entries)) {
		return undefined;
	}
	for (const pair of entries) {
		if (Array.isArray(pair) && pair[0] === key) {
			return pair[1];
		}
	}
	return undefined;
};

/** a generated wrapper class */
interface Wrapper {
	name: string;
	/** members in serialized order: base wrapper's first */
	fields: { name: string; type: Il2CppTypeRef }[];
	/** subtypes by union tag, or `null` for a plain object */
	union: Map<number, number> | null;
}

/** precomputed field layout of a raw-copied struct */
interface RawStruct {
	name: string;
	fields: { name: string; type: Il2CppTypeRef; offset: number }[];
}

/** unmanaged layout */
interface Layout {
	size: number;
	align: number;
}

const PRIMITIVE_SIZES = new Map([
	['bool', 1],
	['byte', 1],
	['sbyte', 1],
	['short', 2],
	['ushort', 2],
	['char', 2],
	['int', 4],
	['uint', 4],
	['float', 4],
	['long', 8],
	['ulong', 8],
	['double', 8],
]);

/** Unity value types whose fields are all floats or ints */
const VECTORS = new Map<string, [string, number]>([
	['Vector2', ['float', 2]],
	['Vector3', ['float', 3]],
	['Vector4', ['float', 4]],
	['Quaternion', ['float', 4]],
	['Color', ['float', 4]],
	['Vector2Int', ['int', 2]],
	['Vector3Int', ['int', 3]],
]);

/** structs serialized raw rather than through their wrapper (besides `*Ptr`) */
const RAW_STRUCTS = new Set([
	'GameplayTag',
	'CameraControlStateInitialParam',
	'PosRot',
	'NpcBehaviorTag',
	'ConditionValue',
	'ValueUnion',
	'AudioId',
	'AbilitySystemData.PlungingAttackData',
	'StringPathHash',
	'BezierKnot',
]);

/** generic structs laid out as a bool flag then the value at its alignment: `Nullable<T>`, `Optional<T>` */
const FLAGGED = new Set(['Nullable', 'Optional']);

/** the MemoryPack wrappers of a client build */
export class MemoryPackSchema {
	readonly runtime: Il2CppRuntime;
	readonly #wrappers = new Map<string, number>();
	readonly #byValue = new Map<string, number[]>();
	readonly #cache = new Map<number, Wrapper>();

	/** @param runtime the build's type information */
	constructor(runtime: Il2CppRuntime) {
		this.runtime = runtime;
		const { metadata } = runtime;
		for (let index = 0; index < metadata.typeDefinitionCount; index++) {
			if (metadata.typeDefinitionDeclaringType(index) !== -1) {
				continue;
			}
			const name = metadata.typeDefinitionName(index);
			if (!name.endsWith('ForMemoryPack')) {
				continue;
			}
			const definition = metadata.typeDefinition(index);
			this.#wrappers.set(name, index);
			for (let m = 0; m < definition.methodCount; m++) {
				const method = metadata.method(definition.methodStart + m);
				if (method.name === 'GetValue' && method.parameterCount === 0) {
					const key = typeKey(runtime.type(method.returnType));
					this.#byValue.getOrInsertComputed(key, () => []).push(index);
				}
			}
		}
	}

	/**
	 * @param name a wrapper class name, e.g. `Beyond_Gameplay_LevelScriptDataForMemoryPack`
	 * @returns its definition index
	 * @throws {FormatError} if the build has no such wrapper
	 */
	wrapperNamed(name: string): number {
		const index = this.#wrappers.get(name);
		if (index === undefined) {
			throw new FormatError(`no MemoryPack wrapper ${name}`);
		}
		return index;
	}

	/**
	 * @param type a serialized type
	 * @returns the definition index of the one wrapper that serializes it, if exactly one does
	 */
	wrapperFor(type: Il2CppTypeRef): number | undefined {
		const found = this.#byValue.get(typeKey(type));
		return found?.length === 1 ? found[0] : undefined;
	}

	/**
	 * @param index a wrapper's definition index
	 * @returns its members and union subtypes
	 */
	wrapper(index: number): Wrapper {
		return this.#cache.getOrInsertComputed(index, (): Wrapper => {
			const { metadata } = this.runtime;
			const definition = metadata.typeDefinition(index);
			const fields: Wrapper['fields'] = [];
			if (definition.parentIndex !== -1) {
				const parent = this.runtime.type(definition.parentIndex);
				if (
					parent.kind === 'definition' &&
					metadata.typeDefinitionName(parent.definition).endsWith('ForMemoryPack')
				) {
					fields.push(...this.wrapper(parent.definition).fields);
				}
			}
			for (let p = 0; p < definition.propertyCount; p++) {
				const property = metadata.property(definition.propertyStart + p);
				if (property.set < 0 || !/^_+\w+__$/.test(property.name)) {
					continue;
				}
				const setter = metadata.method(definition.methodStart + property.set);
				fields.push({
					name: property.name.replace(/^_+|_+$/g, ''),
					type: this.runtime.type(metadata.parameterType(setter.parameterStart)),
				});
			}
			return { name: definition.name, fields, union: this.#unions(definition) };
		});
	}

	#unions(definition: TypeDefinition): Map<number, number> | null {
		const { metadata } = this.runtime;
		const reader = metadata.attributes(definition);
		if (reader === undefined) {
			return null;
		}
		const union = new Map<number, number>();
		for (const constructor of reader.constructors) {
			const attributeName = metadata.typeDefinitionName(metadata.method(constructor).declaringType);
			const args = readAttributeArguments(reader, this.runtime);
			if (attributeName !== 'MemoryPackUnionAttribute') {
				continue;
			}
			const [tag, type] = args;
			if (
				typeof tag !== 'number' ||
				typeof type !== 'object' ||
				type === null ||
				Array.isArray(type) ||
				type.kind !== 'definition'
			) {
				throw new FormatError(`${definition.name} has a malformed MemoryPackUnion attribute`);
			}
			union.set(tag, type.definition);
		}
		return union.size === 0 ? null : union;
	}
}

/** @returns an identity key for a resolved type */
const typeKey = (type: Il2CppTypeRef): string => {
	switch (type.kind) {
		case 'primitive': {
			return `p:${type.name}`;
		}
		case 'definition': {
			return `d:${type.definition}`;
		}
		case 'generic': {
			return `g:${type.definition}<${type.args.map(typeKey).join(',')}>`;
		}
		case 'array': {
			return `a:${type.rank}:${typeKey(type.element)}`;
		}
		case 'pointer': {
			return `r:${typeKey(type.element)}`;
		}
		case 'parameter': {
			return 't';
		}
	}
};

/**
 * reads one attribute's constructor arguments, skipping its named field and property arguments
 *
 * @returns the positional arguments: numbers, strings, booleans, `typeof` types, arrays
 */
const readAttributeArguments = (
	reader: AttributeReader,
	runtime: Il2CppRuntime,
): (number | string | boolean | Il2CppTypeRef | null | unknown[])[] => {
	const argumentCount = reader.compressedU32();
	const fieldCount = reader.compressedU32();
	const propertyCount = reader.compressedU32();
	const value = (kind: number): number | string | boolean | Il2CppTypeRef | null | unknown[] => {
		switch (kind) {
			case 0x02: {
				return reader.byte() !== 0;
			}
			case 0x04:
			case 0x05: {
				return reader.byte();
			}
			case 0x03:
			case 0x06:
			case 0x07: {
				return reader.u16();
			}
			case 0x08: {
				return reader.compressedI32();
			}
			case 0x09: {
				return reader.compressedU32();
			}
			case 0x0c: {
				return reader.u32();
			}
			case 0x0a:
			case 0x0b:
			case 0x0d: {
				return reader.u32() + reader.u32() * 0x1_0000_0000;
			}
			case 0x0e: {
				const length = reader.compressedI32();
				if (length === -1) {
					return null;
				}
				const chars: number[] = [];
				for (let i = 0; i < length; i++) {
					chars.push(reader.byte());
				}
				return utf8.decode(new Uint8Array(chars));
			}
			case 0x1d: {
				const length = reader.compressedI32();
				if (length === -1) {
					return null;
				}
				const elementKind = encodedKind();
				const mixed = reader.byte() === 1;
				return Array.from({ length }, () => value(mixed ? encodedKind() : elementKind));
			}
			case 0xff: {
				const index = reader.compressedI32();
				return index === -1 ? null : runtime.type(index);
			}
			default: {
				throw new FormatError(`unsupported attribute argument kind 0x${kind.toString(16)}`);
			}
		}
	};
	// an enum argument names its enum's type, then is encoded as the enum's underlying type
	const encodedKind = (): number => {
		const kind = reader.byte();
		if (kind !== 0x55) {
			return kind;
		}
		const type = runtime.type(reader.compressedI32());
		if (type.kind !== 'definition') {
			throw new FormatError('enum attribute argument of a non-definition type');
		}
		const underlying = runtime.type(runtime.metadata.typeDefinition(type.definition).elementTypeIndex);
		if (underlying.kind !== 'primitive') {
			throw new FormatError('enum with a non-primitive underlying type');
		}
		return PRIMITIVE_KINDS.get(underlying.name) ?? 0;
	};
	const args = Array.from({ length: argumentCount }, () => value(encodedKind()));
	for (let i = 0; i < fieldCount + propertyCount; i++) {
		value(encodedKind());
		if (reader.compressedI32() < 0) {
			reader.compressedU32();
		}
	}
	return args;
};

const PRIMITIVE_KINDS = new Map([
	['bool', 0x02],
	['char', 0x03],
	['sbyte', 0x04],
	['byte', 0x05],
	['short', 0x06],
	['ushort', 0x07],
	['int', 0x08],
	['uint', 0x09],
	['long', 0x0a],
	['ulong', 0x0b],
	['float', 0x0c],
	['double', 0x0d],
]);

interface Cursor {
	bytes: Uint8Array;
	view: DataView;
	at: number;
}

const advance = (c: Cursor, size: number): number => {
	const at = c.at;
	if (size < 0 || at + size > c.bytes.length) {
		throw new FormatError(`read of ${size} bytes at ${at} passes the end`);
	}
	c.at += size;
	return at;
};

const readU8 = (c: Cursor): number => c.view.getUint8(advance(c, 1));
const readU16 = (c: Cursor): number => c.view.getUint16(advance(c, 2), true);
const readI32 = (c: Cursor): number => c.view.getInt32(advance(c, 4), true);
const readF32 = (c: Cursor): number => c.view.getFloat32(advance(c, 4), true);

const readUtf8 = (c: Cursor): string | null => {
	const length = readI32(c);
	if (length === -1) {
		return null;
	}
	const at = advance(c, length);
	return utf8.decode(c.bytes.subarray(at, at + length));
};

const skipUtf8 = (c: Cursor): void => {
	const length = readI32(c);
	if (length !== -1) {
		advance(c, length);
	}
};

const readListCount = (c: Cursor): number => {
	const count = readI32(c);
	if (count === -1) {
		return 0;
	}
	if (count < 0 || count > c.bytes.length - c.at) {
		throw new FormatError(`collection of ${count} at ${c.at - 4}`);
	}
	return count;
};

/** decodes MemoryPack bytes with a client's schema */
export class MemoryPackReader {
	readonly schema: MemoryPackSchema;
	readonly #strings: (id: number) => string | null | undefined;
	readonly #layouts = new Map<string, Layout | null>();
	readonly #layoutRefs = new WeakMap<Il2CppTypeRef, Layout | null>();
	readonly #rawStructs = new Map<number, RawStruct>();

	/**
	 * @param schema the client's wrappers
	 * @param strings JsonData string pool lookup: the string, `null` for a null string, `undefined` for an id
	 *   the pool lacks (decoded as `#<id>`, or `null` when negative)
	 */
	constructor(schema: MemoryPackSchema, strings: (id: number) => string | null | undefined) {
		this.schema = schema;
		this.#strings = strings;
	}

	/**
	 * @param bytes a serialized object
	 * @param root the name of its wrapper class
	 * @returns the decoded object
	 * @throws {FormatError} if the bytes don't decode as the schema says or don't end where the object does
	 */
	decode(bytes: Uint8Array, root: string): MemoryPackValue {
		const c: Cursor = {
			bytes,
			view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			at: 0,
		};
		const value = this.#wrapper(this.schema.wrapperNamed(root), c, undefined);
		if (c.at !== bytes.length) {
			throw new FormatError(`${root} ends at ${c.at} of ${bytes.length} bytes`);
		}
		return value;
	}

	/**
	 * decodes only the named top-level fields of `root`, skipping unselected fields without allocating values
	 * and stopping once every requested field has been read
	 *
	 * @param bytes a serialized object
	 * @param root the name of its wrapper class
	 * @param fields top-level field names to materialize
	 * @returns an object holding `$type` and the requested fields, or `null` for a null root
	 * @throws {FormatError} if the bytes up through the last requested field don't match the schema
	 */
	decodeFields(bytes: Uint8Array, root: string, fields: ReadonlySet<string>): MemoryPackValue {
		const c: Cursor = {
			bytes,
			view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			at: 0,
		};
		return this.#wrapper(this.schema.wrapperNamed(root), c, fields);
	}

	#wrapper(index: number, c: Cursor, pick: ReadonlySet<string> | undefined): MemoryPackValue {
		const wrapper = this.schema.wrapper(index);
		if (wrapper.union !== null) {
			let tag = readU8(c);
			if (tag === 255) {
				return null;
			}
			// 250 escapes to a u16 for large tags
			if (tag === 250) {
				tag = readU16(c);
			}
			const subtype = wrapper.union.get(tag);
			if (subtype === undefined) {
				throw new FormatError(`${wrapper.name} has no union tag ${tag}`);
			}
			return this.#wrapper(subtype, c, pick);
		}
		const at = c.at;
		const members = readU8(c);
		if (members === 255) {
			return null;
		}
		if (members !== wrapper.fields.length) {
			throw new FormatError(
				`${wrapper.name} at ${at} has ${members} members, expected ${wrapper.fields.length}`,
			);
		}
		const result: { [key: string]: MemoryPackValue } = { $type: wrapper.name };
		let remaining = 0;
		if (pick !== undefined) {
			for (const { name } of wrapper.fields) {
				if (pick.has(name)) {
					remaining++;
				}
			}
		}
		for (const { name, type } of wrapper.fields) {
			if (pick !== undefined && remaining === 0) {
				break;
			}
			try {
				if (pick === undefined || pick.has(name)) {
					result[name] = this.#value(type, false, c);
					if (pick !== undefined) {
						remaining--;
					}
				} else {
					this.#skipValue(type, false, c);
				}
			} catch (error) {
				if (error instanceof FormatError) {
					throw new FormatError(`${wrapper.name}.${name}: ${error.message}`);
				}
				throw error;
			}
		}
		return result;
	}

	#skipWrapper(index: number, c: Cursor): void {
		const wrapper = this.schema.wrapper(index);
		if (wrapper.union !== null) {
			let tag = readU8(c);
			if (tag === 255) {
				return;
			}
			if (tag === 250) {
				tag = readU16(c);
			}
			const subtype = wrapper.union.get(tag);
			if (subtype === undefined) {
				throw new FormatError(`${wrapper.name} has no union tag ${tag}`);
			}
			this.#skipWrapper(subtype, c);
			return;
		}
		const at = c.at;
		const members = readU8(c);
		if (members === 255) {
			return;
		}
		if (members !== wrapper.fields.length) {
			throw new FormatError(
				`${wrapper.name} at ${at} has ${members} members, expected ${wrapper.fields.length}`,
			);
		}
		for (const { name, type } of wrapper.fields) {
			try {
				this.#skipValue(type, false, c);
			} catch (error) {
				if (error instanceof FormatError) {
					throw new FormatError(`${wrapper.name}.${name}: ${error.message}`);
				}
				throw error;
			}
		}
	}

	#value(type: Il2CppTypeRef, listElement: boolean, c: Cursor): MemoryPackValue {
		const { runtime } = this.schema;
		if (type.kind === 'primitive') {
			if (type.name === 'string') {
				const id = readI32(c);
				const text = this.#strings(id);
				return text === undefined ? (id < 0 ? null : `#${id}`) : text;
			}
			return this.#raw(type, c);
		}
		if (type.kind === 'array') {
			if (type.rank !== 1) {
				throw new FormatError(`unsupported array ${runtime.typeName(type)}`);
			}
			return this.#list(c, () => this.#value(type.element, false, c));
		}
		if (type.kind !== 'definition' && type.kind !== 'generic') {
			throw new FormatError(`unsupported type ${runtime.typeName(type)}`);
		}
		const base = runtime.definitionName(type.definition);
		const special = this.#special(base, c);
		if (special !== undefined) {
			return special;
		}
		const layout = this.#layout(type);
		if (layout !== null && (VECTORS.has(base) || FLAGGED.has(base))) {
			return this.#rawAdvance(type, layout, c);
		}
		// these structs are raw copies, except as List elements, which are wrapper-serialized
		if (
			layout !== null &&
			(base.endsWith('Ptr') || RAW_STRUCTS.has(base)) &&
			!(listElement && this.schema.wrapperFor(type) !== undefined)
		) {
			return this.#rawAdvance(type, layout, c);
		}
		if (type.kind === 'generic') {
			const [first, second] = type.args;
			switch (base) {
				case 'List': {
					return this.#list(c, () => this.#value(first, true, c));
				}
				case 'SerializeFieldDictionary': {
					// a header byte: 255 null, 2 a key list then a value list, 1 one list of key/value pairs
					const header = readU8(c);
					switch (header) {
						case 255: {
							return null;
						}
						case 1: {
							return this.#list(c, () => [this.#value(first, false, c), this.#value(second, false, c)]);
						}
						case 2: {
							const keys = this.#list(c, () => this.#value(first, false, c));
							const values = this.#list(c, () => this.#value(second, false, c));
							return keys.map((key, i) => [key, values[i] ?? null]);
						}
						default: {
							throw new FormatError(`SerializeFieldDictionary header ${header} at ${c.at - 1}`);
						}
					}
				}
				case 'Dictionary': {
					const key = this.#layout(first);
					const value = this.#layout(second);
					if (key !== null && value !== null && this.#plain(first) && this.#plain(second)) {
						// a pair of unmanaged types is copied raw as KeyValuePair<K, V>, padding included
						const align = Math.max(key.align, value.align);
						const valueAt = Math.ceil(key.size / value.align) * value.align;
						const size = Math.ceil((valueAt + value.size) / align) * align;
						return this.#list(c, () => {
							const at = advance(c, size);
							return [this.#rawAt(first, at, c), this.#rawAt(second, at + valueAt, c)];
						});
					}
					return this.#list(c, () => [this.#value(first, false, c), this.#value(second, false, c)]);
				}
				default: {
					break;
				}
			}
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		if (definition.enumType) {
			return this.#raw(runtime.type(definition.elementTypeIndex), c);
		}
		const wrapper = this.schema.wrapperFor(type);
		if (wrapper === undefined) {
			throw new FormatError(`no wrapper serializes ${runtime.typeName(type)}`);
		}
		return this.#wrapper(wrapper, c, undefined);
	}

	#skipValue(type: Il2CppTypeRef, listElement: boolean, c: Cursor): void {
		const { runtime } = this.schema;
		if (type.kind === 'primitive') {
			if (type.name === 'string') {
				advance(c, 4);
				return;
			}
			const layout = this.#layout(type);
			if (layout === null) {
				throw new FormatError(`no unmanaged layout for ${runtime.typeName(type)}`);
			}
			advance(c, layout.size);
			return;
		}
		if (type.kind === 'array') {
			if (type.rank !== 1) {
				throw new FormatError(`unsupported array ${runtime.typeName(type)}`);
			}
			const count = readListCount(c);
			for (let i = 0; i < count; i++) {
				this.#skipValue(type.element, false, c);
			}
			return;
		}
		if (type.kind !== 'definition' && type.kind !== 'generic') {
			throw new FormatError(`unsupported type ${runtime.typeName(type)}`);
		}
		const base = runtime.definitionName(type.definition);
		if (this.#skipSpecial(base, c)) {
			return;
		}
		const layout = this.#layout(type);
		if (layout !== null && (VECTORS.has(base) || FLAGGED.has(base))) {
			advance(c, layout.size);
			return;
		}
		if (
			layout !== null &&
			(base.endsWith('Ptr') || RAW_STRUCTS.has(base)) &&
			!(listElement && this.schema.wrapperFor(type) !== undefined)
		) {
			advance(c, layout.size);
			return;
		}
		if (type.kind === 'generic') {
			const [first, second] = type.args;
			switch (base) {
				case 'List': {
					const count = readListCount(c);
					for (let i = 0; i < count; i++) {
						this.#skipValue(first, true, c);
					}
					return;
				}
				case 'SerializeFieldDictionary': {
					const header = readU8(c);
					switch (header) {
						case 255: {
							return;
						}
						case 1: {
							const count = readListCount(c);
							for (let i = 0; i < count; i++) {
								this.#skipValue(first, false, c);
								this.#skipValue(second, false, c);
							}
							return;
						}
						case 2: {
							const keyCount = readListCount(c);
							for (let i = 0; i < keyCount; i++) {
								this.#skipValue(first, false, c);
							}
							const valueCount = readListCount(c);
							for (let i = 0; i < valueCount; i++) {
								this.#skipValue(second, false, c);
							}
							return;
						}
						default: {
							throw new FormatError(`SerializeFieldDictionary header ${header} at ${c.at - 1}`);
						}
					}
				}
				case 'Dictionary': {
					const key = this.#layout(first);
					const value = this.#layout(second);
					if (key !== null && value !== null && this.#plain(first) && this.#plain(second)) {
						const align = Math.max(key.align, value.align);
						const valueAt = Math.ceil(key.size / value.align) * value.align;
						const size = Math.ceil((valueAt + value.size) / align) * align;
						const count = readListCount(c);
						advance(c, count * size);
						return;
					}
					const count = readListCount(c);
					for (let i = 0; i < count; i++) {
						this.#skipValue(first, false, c);
						this.#skipValue(second, false, c);
					}
					return;
				}
				default: {
					break;
				}
			}
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		if (definition.enumType) {
			const elemLayout = this.#layout(runtime.type(definition.elementTypeIndex));
			if (elemLayout === null) {
				throw new FormatError(`no unmanaged layout for ${runtime.typeName(type)}`);
			}
			advance(c, elemLayout.size);
			return;
		}
		const wrapper = this.schema.wrapperFor(type);
		if (wrapper === undefined) {
			throw new FormatError(`no wrapper serializes ${runtime.typeName(type)}`);
		}
		this.#skipWrapper(wrapper, c);
	}

	/** @returns a value of a type with its own formatter, or `undefined` for other types */
	#special(base: string, c: Cursor): MemoryPackValue | undefined {
		switch (base) {
			case 'AnimationCurve': {
				// member count 3, preWrapMode, postWrapMode, raw Keyframe[] (28 bytes each)
				const members = readU8(c);
				if (members === 255) {
					return null;
				}
				if (members !== 3) {
					throw new FormatError(`AnimationCurve with ${members} members`);
				}
				const preWrapMode = readI32(c);
				const postWrapMode = readI32(c);
				const keys = this.#list(c, () => {
					const at = advance(c, 28);
					return Array.from({ length: 7 }, (_, i) => c.view.getFloat32(at + i * 4, true));
				});
				return { $type: 'AnimationCurve', preWrapMode, postWrapMode, keys };
			}
			case 'SendLuaEvent':
			case 'SendLuaEvent1':
			case 'SendLuaEvent2': {
				// member count, ID, inline UTF-8 uid, bool, nextID, bool, Param<string> event name, then one inline UTF-8
				// JSON string per parameter
				const members = readU8(c);
				if (members === 255) {
					return null;
				}
				const id = readI32(c);
				const uid = readUtf8(c);
				const first = readU8(c) !== 0;
				const nextId = readI32(c);
				const second = readU8(c) !== 0;
				const eventName = this.#wrapper(
					this.schema.wrapperNamed('Beyond_Gameplay_Actions_Param_string_ForMemoryPack'),
					c,
					undefined,
				);
				return {
					$type: base,
					ID: id,
					uid,
					flag0: first,
					nextID: nextId,
					flag1: second,
					eventName,
					params: Array.from({ length: members - 6 }, () => readUtf8(c)),
				};
			}
			case 'AudioBlackScreenBehaviour': {
				// a raw struct: the skips are its padding
				const preset = readU8(c);
				const flags = readU8(c);
				const fadeIn = readU8(c) !== 0;
				advance(c, 1);
				const inTime = readF32(c);
				const fadeOut = readU8(c) !== 0;
				advance(c, 3);
				return { $type: base, preset, flags, fadeIn, inTime, fadeOut, outTime: readF32(c) };
			}
			default: {
				return undefined;
			}
		}
	}

	#skipSpecial(base: string, c: Cursor): boolean {
		switch (base) {
			case 'AnimationCurve': {
				const members = readU8(c);
				if (members === 255) {
					return true;
				}
				if (members !== 3) {
					throw new FormatError(`AnimationCurve with ${members} members`);
				}
				advance(c, 8);
				const count = readListCount(c);
				advance(c, count * 28);
				return true;
			}
			case 'SendLuaEvent':
			case 'SendLuaEvent1':
			case 'SendLuaEvent2': {
				const members = readU8(c);
				if (members === 255) {
					return true;
				}
				advance(c, 4);
				skipUtf8(c);
				advance(c, 6);
				this.#skipWrapper(this.schema.wrapperNamed('Beyond_Gameplay_Actions_Param_string_ForMemoryPack'), c);
				for (let i = 0; i < members - 6; i++) {
					skipUtf8(c);
				}
				return true;
			}
			case 'AudioBlackScreenBehaviour': {
				advance(c, 16);
				return true;
			}
			default: {
				return false;
			}
		}
	}

	/** @returns whether a type is a primitive, vector or enum, the kinds a raw dictionary holds */
	#plain(type: Il2CppTypeRef): boolean {
		if (type.kind === 'primitive') {
			return true;
		}
		if (type.kind !== 'definition') {
			return false;
		}
		const definition = this.schema.runtime.metadata.typeDefinition(type.definition);
		return definition.enumType || VECTORS.has(definition.name);
	}

	/** @returns the unmanaged layout of a type, or `null` if it holds references or is unknown */
	#layout(type: Il2CppTypeRef): Layout | null {
		if (type.kind === 'primitive') {
			const size = PRIMITIVE_SIZES.get(type.name);
			return size === undefined ? null : { size, align: size };
		}
		const cached = this.#layoutRefs.get(type);
		if (cached !== undefined) {
			return cached;
		}
		const key = typeKey(type);
		if (this.#layouts.has(key)) {
			const result = this.#layouts.get(key) ?? null;
			this.#layoutRefs.set(type, result);
			return result;
		}
		this.#layouts.set(key, null);
		const result = this.#computeLayout(type);
		this.#layouts.set(key, result);
		this.#layoutRefs.set(type, result);
		return result;
	}

	#computeLayout(type: Il2CppTypeRef): Layout | null {
		const { runtime } = this.schema;
		if (type.kind === 'primitive') {
			const size = PRIMITIVE_SIZES.get(type.name);
			return size === undefined ? null : { size, align: size };
		}
		if (type.kind === 'generic' && FLAGGED.has(runtime.definitionName(type.definition))) {
			const inner = this.#layout(type.args[0]);
			return (
				inner && {
					size: Math.ceil((inner.align + inner.size) / inner.align) * inner.align,
					align: inner.align,
				}
			);
		}
		if (type.kind !== 'definition') {
			return null;
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		const vector = VECTORS.get(definition.name);
		if (vector !== undefined) {
			const size = PRIMITIVE_SIZES.get(vector[0])!;
			return { size: size * vector[1], align: size };
		}
		if (definition.enumType) {
			return this.#layout(runtime.type(definition.elementTypeIndex));
		}
		if (!definition.valueType) {
			return null;
		}
		const fields = runtime.fields(definition).filter((field) => !field.static);
		if (fields.length === 0) {
			return null;
		}
		let size = 0;
		let align = 1;
		for (const field of fields) {
			const layout = this.#layout(field.type);
			if (layout === null) {
				return null;
			}
			size = Math.max(size, field.offset + layout.size);
			align = Math.max(align, layout.align);
		}
		return { size: Math.ceil(size / align) * align, align };
	}

	#rawAdvance(type: Il2CppTypeRef, layout: Layout, c: Cursor): MemoryPackValue {
		return this.#rawAt(type, advance(c, layout.size), c);
	}

	#raw(type: Il2CppTypeRef, c: Cursor): MemoryPackValue {
		const layout = this.#layout(type);
		if (layout === null) {
			throw new FormatError(`no unmanaged layout for ${this.schema.runtime.typeName(type)}`);
		}
		if (type.kind === 'primitive' && type.name === 'bool') {
			const value = readU8(c);
			if (value > 1) {
				throw new FormatError(`bool ${value}`);
			}
			return value === 1;
		}
		return this.#rawAdvance(type, layout, c);
	}

	/** @returns an unmanaged value at an offset */
	#rawAt(type: Il2CppTypeRef, at: number, c: Cursor): MemoryPackValue {
		const { runtime } = this.schema;
		const { view } = c;
		if (type.kind === 'primitive') {
			switch (type.name) {
				case 'bool': {
					return view.getUint8(at) !== 0;
				}
				case 'byte': {
					return view.getUint8(at);
				}
				case 'sbyte': {
					return view.getInt8(at);
				}
				case 'short': {
					return view.getInt16(at, true);
				}
				case 'ushort':
				case 'char': {
					return view.getUint16(at, true);
				}
				case 'int': {
					return view.getInt32(at, true);
				}
				case 'uint': {
					return view.getUint32(at, true);
				}
				case 'float': {
					return view.getFloat32(at, true);
				}
				case 'double': {
					return view.getFloat64(at, true);
				}
				case 'long': {
					return view.getBigInt64(at, true).toString();
				}
				case 'ulong': {
					return view.getBigUint64(at, true).toString();
				}
				default: {
					throw new FormatError(`no raw form for ${type.name}`);
				}
			}
		}
		if (type.kind === 'generic' && FLAGGED.has(runtime.definitionName(type.definition))) {
			const inner = this.#layout(type.args[0])!;
			const present = view.getUint8(at) !== 0;
			if (runtime.definitionName(type.definition) === 'Nullable') {
				return present ? this.#rawAt(type.args[0], at + inner.align, c) : null;
			}
			// an Optional keeps its value when disabled
			return { $type: 'Optional', enabled: present, value: this.#rawAt(type.args[0], at + inner.align, c) };
		}
		if (type.kind !== 'definition') {
			throw new FormatError(`no raw form for ${runtime.typeName(type)}`);
		}
		const cached = this.#rawStructs.get(type.definition);
		if (cached !== undefined) {
			const result: { [key: string]: MemoryPackValue } = { $type: cached.name };
			for (const field of cached.fields) {
				result[field.name] = this.#rawAt(field.type, at + field.offset, c);
			}
			return result;
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		const vector = VECTORS.get(definition.name);
		if (vector !== undefined) {
			const element: Il2CppTypeRef = { kind: 'primitive', name: vector[0] };
			const size = PRIMITIVE_SIZES.get(vector[0])!;
			return Array.from({ length: vector[1] }, (_, i) => this.#rawAt(element, at + i * size, c));
		}
		if (definition.enumType) {
			return this.#rawAt(runtime.type(definition.elementTypeIndex), at, c);
		}
		const struct: RawStruct = {
			name: definition.name,
			fields: runtime
				.fields(definition)
				.filter((field) => !field.static)
				.map((field) => ({
					name: field.name.replace(/^<(\w+)>k__BackingField$/, '$1'),
					type: field.type,
					offset: field.offset,
				})),
		};
		this.#rawStructs.set(definition.index, struct);
		const result: { [key: string]: MemoryPackValue } = { $type: struct.name };
		for (const field of struct.fields) {
			result[field.name] = this.#rawAt(field.type, at + field.offset, c);
		}
		return result;
	}

	/** @returns a collection's items; a null collection (count -1) reads as empty */
	#list<T>(c: Cursor, item: () => T): T[] {
		const count = readListCount(c);
		return Array.from({ length: count }, item);
	}
}

const utf8 = new TextDecoder('utf-8');
