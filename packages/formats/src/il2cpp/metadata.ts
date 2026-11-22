import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

// IL2CPP `global-metadata.dat`, version 29: names and shapes of the managed types (type, field, property, method
// and parameter definitions, custom attribute data). the types those definitions name are indices into the
// binary's type table (see registration.ts). layouts follow Perfare/Il2CppDumper (MIT), `MetadataClass.cs`.
// Endfield's type definitions carry one extra int32 after `interfaceOffsetsStart`; the row size tells which.

const SANITY = 0xfab11baf;

/** header tables, by their (offset, size) pair's position in the v29 header */
const Table = {
	String: 2,
	Properties: 4,
	Methods: 5,
	Parameters: 10,
	Fields: 11,
	TypeDefinitions: 19,
	Images: 20,
	AttributeData: 24,
	AttributeDataRanges: 25,
} as const;

/** a managed type definition */
export interface TypeDefinition {
	index: number;
	name: string;
	namespace: string;
	/** index into the binary's type table of the type itself */
	byvalTypeIndex: number;
	/** type table index of the enclosing type, or -1 */
	declaringTypeIndex: number;
	/** type table index of the base type, or -1 */
	parentIndex: number;
	/** for an enum, type table index of its underlying type */
	elementTypeIndex: number;
	/** index into the generic containers, or -1 for a non-generic type */
	genericContainerIndex: number;
	fieldStart: number;
	fieldCount: number;
	methodStart: number;
	methodCount: number;
	propertyStart: number;
	propertyCount: number;
	valueType: boolean;
	enumType: boolean;
	token: number;
}

/** a field definition */
export interface FieldDefinition {
	name: string;
	typeIndex: number;
	token: number;
}

/**
 * a property definition; accessors are method indices relative to the declaring type's `methodStart`, -1 for
 * none
 */
export interface PropertyDefinition {
	name: string;
	get: number;
	set: number;
}

/** a method definition */
export interface MethodDefinition {
	name: string;
	declaringType: number;
	returnType: number;
	parameterStart: number;
	parameterCount: number;
}

/** a parsed `global-metadata.dat` */
export class Il2CppMetadata {
	readonly version: number;
	readonly typeDefinitionCount: number;
	readonly #view: ByteView;
	readonly #tables: { offset: number; size: number }[];
	readonly #typeRow: number;
	readonly #extra: number;
	readonly #strings = new Map<number, string>();

	/**
	 * @param bytes the whole file
	 * @throws {FormatError} if it isn't version 29 metadata or its type table has an unknown row size
	 */
	constructor(bytes: Uint8Array) {
		this.#view = new ByteView(bytes, 'IL2CPP metadata');
		if (bytes.length < 272 || this.#view.u32(0) !== SANITY) {
			throw new FormatError('not IL2CPP metadata');
		}
		this.version = this.#view.i32(4);
		if (this.version !== 29) {
			throw new FormatError(`IL2CPP metadata version ${this.version}; only 29 is read`);
		}
		this.#tables = Array.from({ length: 32 }, (_, i) => ({
			offset: this.#view.u32(8 + i * 8),
			size: this.#view.i32(12 + i * 8),
		}));
		const typeBytes = this.#tables[Table.TypeDefinitions].size;
		// 88 bytes is the standard row; 92 has one extra int32
		const fits = [88, 92].filter((row) => typeBytes % row === 0);
		if (fits.length !== 1) {
			throw new FormatError(`type definition table of ${typeBytes} bytes has no single known row size`);
		}
		this.#typeRow = fits[0];
		this.#extra = this.#typeRow - 88;
		this.typeDefinitionCount = typeBytes / this.#typeRow;
	}

	/**
	 * @param index an index into the string table
	 * @returns the null-terminated string there
	 */
	string(index: number): string {
		return this.#strings.getOrInsertComputed(index, () => {
			return this.#view.cString(this.#tables[Table.String].offset + index)[0];
		});
	}

	/**
	 * @param index a type definition index
	 * @returns its name, without decoding the rest of the row
	 * @throws {FormatError} if the index is out of range
	 */
	typeDefinitionName(index: number): string {
		const at = this.#row(Table.TypeDefinitions, this.#typeRow, index);
		return this.string(this.#view.i32(at));
	}

	/**
	 * @param index a type definition index
	 * @returns the type table index of its enclosing type, or -1 if top-level
	 * @throws {FormatError} if the index is out of range
	 */
	typeDefinitionDeclaringType(index: number): number {
		const at = this.#row(Table.TypeDefinitions, this.#typeRow, index);
		return this.#view.i32(at + 12);
	}

	/**
	 * @param index a type definition index
	 * @returns the definition
	 * @throws {FormatError} if the index is out of range
	 */
	typeDefinition(index: number): TypeDefinition {
		const at = this.#row(Table.TypeDefinitions, this.#typeRow, index);
		const view = this.#view;
		const tail = at + 64 + this.#extra;
		const bitfield = view.u32(tail + 16);
		return {
			index,
			name: this.string(view.i32(at)),
			namespace: this.string(view.i32(at + 4)),
			byvalTypeIndex: view.i32(at + 8),
			declaringTypeIndex: view.i32(at + 12),
			parentIndex: view.i32(at + 16),
			elementTypeIndex: view.i32(at + 20),
			genericContainerIndex: view.i32(at + 24),
			fieldStart: view.i32(at + 32),
			methodStart: view.i32(at + 36),
			propertyStart: view.i32(at + 44),
			methodCount: view.u16(tail),
			propertyCount: view.u16(tail + 2),
			fieldCount: view.u16(tail + 4),
			valueType: (bitfield & 1) !== 0,
			enumType: (bitfield & 2) !== 0,
			token: view.u32(tail + 20),
		};
	}

	/** @returns a field definition by index */
	field(index: number): FieldDefinition {
		const at = this.#row(Table.Fields, 12, index);
		return {
			name: this.string(this.#view.u32(at)),
			typeIndex: this.#view.i32(at + 4),
			token: this.#view.u32(at + 8),
		};
	}

	/** @returns a property definition by index */
	property(index: number): PropertyDefinition {
		const at = this.#row(Table.Properties, 20, index);
		return {
			name: this.string(this.#view.u32(at)),
			get: this.#view.i32(at + 4),
			set: this.#view.i32(at + 8),
		};
	}

	/** @returns a method definition by index */
	method(index: number): MethodDefinition {
		const at = this.#row(Table.Methods, 32, index);
		return {
			name: this.string(this.#view.u32(at)),
			declaringType: this.#view.i32(at + 4),
			returnType: this.#view.i32(at + 8),
			parameterStart: this.#view.i32(at + 12),
			parameterCount: this.#view.u16(at + 30),
		};
	}

	/** @returns a parameter's type table index */
	parameterType(index: number): number {
		return this.#view.i32(this.#row(Table.Parameters, 12, index) + 8);
	}

	/**
	 * custom attribute data of a type: a compressed count, that many constructor method indices (int32), then
	 * per attribute its compressed argument, field and property counts and encoded values (see
	 * {@link AttributeReader})
	 *
	 * @param definition a type definition
	 * @returns a reader over its attribute data, or `undefined` without attributes
	 */
	attributes(definition: TypeDefinition): AttributeReader | undefined {
		const range = this.#imageAttributeRange(definition.index);
		if (range === undefined || range.count === 0 || range.start < 0) {
			return undefined;
		}
		const { offset, size } = this.#tables[Table.AttributeDataRanges];
		const totalCount = size / 8;
		const target = definition.token;
		// IL2CPP v29 sorts each image's AttributeDataRanges slice by token for binary search
		let lo = range.start;
		let hi = range.start + range.count - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const token = this.#view.u32(offset + mid * 8);
			if (token < target) {
				lo = mid + 1;
			} else if (token > target) {
				hi = mid - 1;
			} else {
				found = mid;
				break;
			}
		}
		if (found === -1) {
			return undefined;
		}
		const at = offset + found * 8;
		const start = this.#view.u32(at + 4);
		const end = found + 1 < totalCount ? this.#view.u32(at + 12) : this.#tables[Table.AttributeData].size;
		const base = this.#tables[Table.AttributeData].offset;
		return new AttributeReader(this.#view.subarray(base + start, end - start));
	}

	#imageAttributeRange(typeIndex: number): { start: number; count: number } | undefined {
		const { offset, size } = this.#tables[Table.Images];
		const imageCount = size / 40;
		let lo = 0;
		let hi = imageCount - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const at = offset + mid * 40;
			const typeStart = this.#view.i32(at + 8);
			const typeCount = this.#view.u32(at + 12);
			if (typeIndex < typeStart) {
				hi = mid - 1;
			} else if (typeIndex >= typeStart + typeCount) {
				lo = mid + 1;
			} else {
				return { start: this.#view.i32(at + 32), count: this.#view.u32(at + 36) };
			}
		}
		// fall back to a scan if an empty image carries an out-of-order typeStart (e.g. -1)
		for (let i = 0; i < imageCount; i++) {
			const at = offset + i * 40;
			const typeStart = this.#view.i32(at + 8);
			const typeCount = this.#view.u32(at + 12);
			if (typeIndex >= typeStart && typeIndex < typeStart + typeCount) {
				return { start: this.#view.i32(at + 32), count: this.#view.u32(at + 36) };
			}
		}
		return undefined;
	}

	#row(table: number, size: number, index: number): number {
		const { offset, size: total } = this.#tables[table];
		if (!Number.isInteger(index) || index < 0 || (index + 1) * size > total) {
			throw new FormatError(`metadata row ${index} outside table ${table}`);
		}
		return offset + index * size;
	}
}

/** reads one type's custom attribute blob */
export class AttributeReader {
	readonly #bytes: Uint8Array;
	readonly #view: DataView;
	#at = 0;
	/** constructor method indices, one per attribute */
	readonly constructors: number[];

	/** @param bytes the type's attribute data */
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const count = this.compressedU32();
		this.constructors = Array.from({ length: count }, (_, i) => this.#view.getInt32(this.#at + i * 4, true));
		this.#at += count * 4;
	}

	/** @returns the next compressed unsigned int32 */
	compressedU32(): number {
		const first = this.#byte();
		if ((first & 0x80) === 0) {
			return first;
		}
		if ((first & 0xc0) === 0x80) {
			return ((first & 0x3f) << 8) | this.#byte();
		}
		if ((first & 0xe0) === 0xc0) {
			return (((first & 0x1f) << 24) | (this.#byte() << 16) | (this.#byte() << 8) | this.#byte()) >>> 0;
		}
		switch (first) {
			case 0xf0: {
				return (this.#byte() | (this.#byte() << 8) | (this.#byte() << 16) | (this.#byte() << 24)) >>> 0;
			}
			case 0xfe: {
				return 0xfffffffe;
			}
			case 0xff: {
				return 0xffffffff;
			}
			default: {
				throw new FormatError(`invalid compressed integer 0x${first.toString(16)}`);
			}
		}
	}

	/** @returns the next compressed signed int32 (zigzag over {@link compressedU32}) */
	compressedI32(): number {
		const encoded = this.compressedU32();
		if (encoded === 0xffffffff) {
			return -0x80000000;
		}
		const magnitude = Math.floor(encoded / 2);
		return encoded % 2 === 1 ? -(magnitude + 1) : magnitude;
	}

	/** @returns the next byte */
	byte(): number {
		return this.#byte();
	}

	/** @returns the next little-endian unsigned 16-bit integer */
	u16(): number {
		const at = this.#at;
		if (at + 2 > this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
		this.#at = at + 2;
		return this.#view.getUint16(at, true);
	}

	/** @returns the next little-endian unsigned 32-bit integer */
	u32(): number {
		const at = this.#at;
		if (at + 4 > this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
		this.#at = at + 4;
		return this.#view.getUint32(at, true);
	}

	/** @param size bytes to skip */
	skip(size: number): void {
		this.#at += size;
		if (this.#at > this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
	}

	#byte(): number {
		if (this.#at >= this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
		return this.#bytes[this.#at++];
	}
}
