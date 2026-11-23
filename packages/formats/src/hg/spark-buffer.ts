import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

// SparkBuffer config tables (`Data/TableCfg/*.bytes`, Table group; layout in
// docs/game-data/containers.md#sparkbuffer-config-tables).

/** value type codes (the game's `SparkType`) */
const SparkType = {
	Bool: 0,
	Byte: 1,
	Int: 2,
	Long: 3,
	Float: 4,
	Double: 5,
	Enum: 6,
	String: 7,
	Bean: 8,
	Array: 9,
	Map: 10,
} as const;

/** a decoded SparkBuffer bean or map */
export type SparkBean = { [field: string]: SparkValue };

/**
 * a decoded SparkBuffer value; enums decode to their numeric value, maps to objects keyed by their keys as
 * strings
 */
export type SparkValue = boolean | number | bigint | string | null | SparkValue[] | SparkBean;

/**
 * @param value a decoded value
 * @returns whether it's a bean or a map (an object), not null, a scalar or an array
 */
export const isSparkBean = (value: SparkValue | undefined): value is SparkBean =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** a field's or element's type */
interface TypeRef {
	type: number;
	/** the bean's type hash, for beans */
	typeHash: number;
	/** the key type, for maps */
	key: TypeRef | null;
	/** the element type, for arrays; the value type, for maps */
	element: TypeRef | null;
}

interface BeanType {
	name: string;
	fields: { name: string; ref: TypeRef }[];
}

/** a decoded map table */
export interface SparkTable {
	name: string;
	/** entries in storage order */
	entries: [key: number | bigint | string, value: SparkValue][];
}

/**
 * decodes a SparkBuffer map table
 *
 * @param bytes the table file
 * @returns the table's entries as plain values
 * @throws {FormatError} on unsupported types or framing errors
 */
export const parseSparkTable = (bytes: Uint8Array): SparkTable => {
	const view = new ByteView(bytes, 'spark');
	let pos = 0;

	/** reads a type ref at `pos`, advancing `pos` past it */
	const readRef = (where: string): TypeRef => {
		const type = view.u8(pos++);
		switch (type) {
			case SparkType.Bool:
			case SparkType.Byte:
			case SparkType.Int:
			case SparkType.Long:
			case SparkType.Float:
			case SparkType.Double:
			case SparkType.String: {
				return { type, typeHash: 0, key: null, element: null };
			}
			case SparkType.Enum:
			case SparkType.Bean: {
				pos = align(pos, 4);
				const typeHash = view.u32(pos);
				pos += 4;
				return { type, typeHash, key: null, element: null };
			}
			case SparkType.Array: {
				return { type, typeHash: 0, key: null, element: readRef(where) };
			}
			case SparkType.Map: {
				const key = readRef(`${where} key`);
				const element = readRef(`${where} value`);
				return { type, typeHash: 0, key, element };
			}
			default: {
				throw new FormatError(`unsupported spark type ${type} in ${where}`);
			}
		}
	};

	const readCString = (): string => {
		const [value, end] = view.cString(pos);
		pos = end;
		return value;
	};

	const types = new Map<number, BeanType>();
	{
		pos = view.u32(0);
		const count = view.u32(pos);
		pos += 4;
		for (let t = 0; t < count; t++) {
			const kind = view.u8(pos++);
			if (kind !== SparkType.Bean && kind !== SparkType.Enum) {
				throw new FormatError(`unsupported spark type definition kind ${kind}`);
			}
			pos = align(pos, 4);
			const hash = view.u32(pos);
			pos += 4;
			const name = readCString();
			pos = align(pos, 4);
			const memberCount = view.u32(pos);
			pos += 4;
			if (kind === SparkType.Enum) {
				// values are read as numbers, so the names aren't kept
				for (let v = 0; v < memberCount; v++) {
					pos = align(view.cString(pos)[1], 4) + 4;
				}
				continue;
			}
			const fields: BeanType['fields'] = [];
			for (let f = 0; f < memberCount; f++) {
				const fieldName = readCString();
				const ref = readRef(`${name}.${fieldName}`);
				fields.push({ name: fieldName, ref });
			}
			types.set(hash, { name, fields });
		}
	}

	pos = view.u32(4);
	const rootKind = view.u8(pos++);
	if (rootKind !== SparkType.Map) {
		throw new FormatError(`unsupported spark root kind ${rootKind}`);
	}
	const name = readCString();
	const keyRef = readRef(`${name} key`);
	const valueRef = readRef(`${name} value`);

	/** reads a value of type `ref` packed at or after `pos`, advancing `pos` past it */
	const read = (ref: TypeRef): SparkValue => {
		switch (ref.type) {
			case SparkType.Bool: {
				return view.u8(pos++) !== 0;
			}
			case SparkType.Byte: {
				return view.u8(pos++);
			}
			case SparkType.Float: {
				const p = align(pos, 4);
				pos = p + 4;
				return view.f32(p);
			}
			case SparkType.Double: {
				const p = align(pos, 8);
				pos = p + 8;
				return view.f64(p);
			}
			case SparkType.Int:
			case SparkType.Enum: {
				const p = align(pos, 4);
				pos = p + 4;
				return view.i32(p);
			}
			case SparkType.Long: {
				const p = align(pos, 8);
				pos = p + 8;
				return view.i64(p);
			}
			case SparkType.String: {
				const p = align(pos, 4);
				const offset = view.u32(p);
				pos = p + 4;
				return offset === 0xffffffff ? null : view.cString(offset)[0];
			}
			case SparkType.Bean: {
				const p = align(pos, 4);
				const offset = view.u32(p);
				if (offset === 0xffffffff) {
					pos = p + 4;
					return null;
				}
				const bean = readBean(ref.typeHash, offset);
				pos = p + 4;
				return bean;
			}
			case SparkType.Array: {
				const p = align(pos, 4);
				const offset = view.u32(p);
				if (offset === 0xffffffff) {
					pos = p + 4;
					return null;
				}
				const items: SparkValue[] = [];
				const count = view.u32(offset);
				pos = offset + 4;
				for (let i = 0; i < count; i++) {
					items.push(read(ref.element!));
				}
				pos = p + 4;
				return items;
			}
			case SparkType.Map: {
				const p = align(pos, 4);
				const offset = view.u32(p);
				if (offset === 0xffffffff) {
					pos = p + 4;
					return null;
				}
				const out: SparkBean = {};
				for (const [key, value] of readMap(ref.key!, ref.element!, offset, 'nested map')) {
					out[String(key)] = value;
				}
				pos = p + 4;
				return out;
			}
			default: {
				throw new FormatError(`unsupported spark value type ${ref.type}`);
			}
		}
	};
	const readBean = (hash: number, start: number): SparkBean => {
		const type = types.get(hash);
		if (type === undefined) {
			throw new FormatError(`unknown spark bean hash ${hash.toString(16)}`);
		}
		const out: SparkBean = {};
		pos = start;
		for (const field of type.fields) {
			out[field.name] = read(field.ref);
		}
		return out;
	};

	/** reads a hash map stored at `data` (the root's and nested maps' layout) */
	const readMap = (
		keyType: TypeRef,
		valueType: TypeRef,
		data: number,
		where: string,
	): SparkTable['entries'] => {
		if (
			keyType.type !== SparkType.Int &&
			keyType.type !== SparkType.Long &&
			keyType.type !== SparkType.String
		) {
			throw new FormatError(`unsupported spark key type ${keyType.type} in ${where}`);
		}
		const entries: SparkTable['entries'] = [];
		const slots = view.u32(data);
		for (let s = 0; s < slots; s++) {
			const offset = view.u32(data + 4 + s * 8);
			const count = view.u32(data + 8 + s * 8);
			pos = offset;
			for (let i = 0; i < count; i++) {
				const key = read(keyType);
				const value = read(valueType);
				// the key type was checked above; this narrows the value for TypeScript
				if (key === null || typeof key === 'object' || typeof key === 'boolean') {
					throw new FormatError(`null spark key in ${where}`);
				}
				entries.push([key, value]);
			}
		}
		return entries;
	};

	return { name, entries: readMap(keyRef, valueRef, view.u32(8), name) };
};

const align = (at: number, to: number): number => Math.ceil(at / to) * to;
