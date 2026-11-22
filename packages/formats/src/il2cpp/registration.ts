import { FormatError } from '../binary/binary-reader.ts';
import { type PeImage, requireVaOffset, vaToOffset } from '../binary/pe.ts';

import type { Il2CppMetadata, TypeDefinition } from './metadata.ts';

// the binary half of IL2CPP type information: the metadata registration in GameAssembly holds the type table
// (`Il2CppType` records that metadata indices point into) and the field offsets. it's found by its counts, the
// way Perfare/Il2CppDumper (MIT) searches for it: the field-offset and type-size counts both equal the number of
// type definitions.

/** a resolved type */
export type Il2CppTypeRef =
	| { kind: 'primitive'; name: string }
	| { kind: 'definition'; definition: number }
	| { kind: 'generic'; definition: number; args: Il2CppTypeRef[] }
	| { kind: 'array'; element: Il2CppTypeRef; rank: number }
	| { kind: 'parameter' }
	| { kind: 'pointer'; element: Il2CppTypeRef };

/** a field with its resolved type */
export interface ResolvedField {
	name: string;
	type: Il2CppTypeRef;
	/** byte offset in an instance; for value types, from the start of the value */
	offset: number;
	static: boolean;
}

/** `Il2CppTypeEnum` values that name C# primitives */
const PRIMITIVES = new Map([
	[0x01, 'void'],
	[0x02, 'bool'],
	[0x03, 'char'],
	[0x04, 'sbyte'],
	[0x05, 'byte'],
	[0x06, 'short'],
	[0x07, 'ushort'],
	[0x08, 'int'],
	[0x09, 'uint'],
	[0x0a, 'long'],
	[0x0b, 'ulong'],
	[0x0c, 'float'],
	[0x0d, 'double'],
	[0x0e, 'string'],
	[0x16, 'TypedReference'],
	[0x18, 'IntPtr'],
	[0x19, 'UIntPtr'],
	[0x1c, 'object'],
]);

/** field attribute flags */
const FIELD_STATIC = 0x10;
const FIELD_LITERAL = 0x40;

/** type information of an IL2CPP build: its metadata and the binary's registration */
export class Il2CppRuntime {
	readonly metadata: Il2CppMetadata;
	readonly #image: PeImage;
	readonly #types: number;
	readonly #typeCount: number;
	readonly #fieldOffsets: number;
	readonly #resolved = new Map<number, Il2CppTypeRef>();
	readonly #definitionNames = new Map<number, string>();
	readonly #fields = new Map<number, readonly ResolvedField[]>();

	/**
	 * @param metadata the build's metadata
	 * @param image its GameAssembly
	 * @throws {FormatError} if no single metadata registration matches the metadata's type count
	 */
	constructor(metadata: Il2CppMetadata, image: PeImage) {
		this.metadata = metadata;
		this.#image = image;
		const { view } = image;
		const count = BigInt(metadata.typeDefinitionCount);
		const found: number[] = [];
		for (const section of image.sections.filter(({ name }) => name === '.data' || name === '.rdata')) {
			const end = section.rawOffset + section.rawSize - 128;
			for (let at = section.rawOffset + 80; at < end; at += 8) {
				// fieldOffsetsCount at +80 and typeDefinitionsSizesCount at +96 of the registration
				if (view.u64(at) !== count || view.u64(at + 16) !== count) {
					continue;
				}
				const base = at - 80;
				const typeCount = view.i64(base + 48);
				if (
					typeCount > 0n &&
					typeCount < 10_000_000n &&
					vaToOffset(image, view.u64(base + 56)) !== undefined &&
					vaToOffset(image, view.u64(base + 88)) !== undefined
				) {
					found.push(base);
				}
			}
		}
		if (found.length !== 1) {
			throw new FormatError(`found ${found.length} IL2CPP metadata registrations, expected one`);
		}
		const [registration] = found;
		this.#typeCount = Number(view.i64(registration + 48));
		this.#types = requireVaOffset(image, view.u64(registration + 56));
		this.#fieldOffsets = requireVaOffset(image, view.u64(registration + 88));
	}

	/**
	 * @param index an index into the binary's type table, as metadata stores them
	 * @returns the type
	 * @throws {FormatError} if the index or a referenced address is out of range, or the type kind is unknown
	 */
	type(index: number): Il2CppTypeRef {
		return this.#resolved.getOrInsertComputed(index, () => {
			if (!Number.isInteger(index) || index < 0 || index >= this.#typeCount) {
				throw new FormatError(`type index ${index} outside ${this.#typeCount}`);
			}
			return this.#typeAt(this.#image.view.u64(this.#types + index * 8));
		});
	}

	/**
	 * @param index a type table index
	 * @returns the attribute flags of that type entry (field and parameter types carry their member's flags)
	 */
	typeAttributes(index: number): number {
		const { view } = this.#image;
		return view.u32(requireVaOffset(this.#image, view.u64(this.#types + index * 8)) + 8) & 0xffff;
	}

	/**
	 * @param definition a type definition
	 * @returns its fields, constants left out, with offsets for instance fields
	 */
	fields(definition: TypeDefinition): readonly ResolvedField[] {
		return this.#fields.getOrInsertComputed(definition.index, () => {
			const { view } = this.#image;
			const fields: ResolvedField[] = [];
			const table = view.u64(this.#fieldOffsets + definition.index * 8);
			const tableOffset = table === 0n ? 0 : requireVaOffset(this.#image, table);
			for (let i = 0; i < definition.fieldCount; i++) {
				const field = this.metadata.field(definition.fieldStart + i);
				const attributes = this.typeAttributes(field.typeIndex);
				if ((attributes & FIELD_LITERAL) !== 0) {
					continue;
				}
				const isStatic = (attributes & FIELD_STATIC) !== 0;
				let offset = table === 0n ? 0 : view.i32(tableOffset + i * 4);
				// instance offsets count the object header, which a value type doesn't have
				if (definition.valueType && !isStatic) {
					offset -= 16;
				}
				fields.push({ name: field.name, type: this.type(field.typeIndex), offset, static: isStatic });
			}
			return fields;
		});
	}

	/**
	 * @param type a resolved type
	 * @returns its C# name as IL2CPP dumps print it: no namespace, nesting with `.`, generic arguments, keyword
	 *   primitives, e.g. `Dictionary<uint, LevelEnemyData>`, `LevelScriptTaskData.TaskConditionData`, `int[]`
	 */
	typeName(type: Il2CppTypeRef): string {
		switch (type.kind) {
			case 'primitive': {
				return type.name;
			}
			case 'definition': {
				return this.definitionName(type.definition);
			}
			case 'generic': {
				return `${this.definitionName(type.definition)}<${type.args.map((arg) => this.typeName(arg)).join(', ')}>`;
			}
			case 'array': {
				return `${this.typeName(type.element)}[${','.repeat(type.rank - 1)}]`;
			}
			case 'pointer': {
				return `${this.typeName(type.element)}*`;
			}
			case 'parameter': {
				return 'T';
			}
		}
	}

	/**
	 * @param index a type definition index
	 * @returns its name with enclosing types, without generic arity or arguments
	 */
	definitionName(index: number): string {
		const cached = this.#definitionNames.get(index);
		if (cached !== undefined) {
			return cached;
		}
		const name = this.metadata.typeDefinitionName(index).replace(/`\d+$/, '');
		const declaringTypeIndex = this.metadata.typeDefinitionDeclaringType(index);
		let result: string;
		if (declaringTypeIndex === -1) {
			result = name;
		} else {
			const outer = this.type(declaringTypeIndex);
			if (outer.kind !== 'definition' && outer.kind !== 'generic') {
				throw new FormatError(`type ${name} is nested in a ${outer.kind}`);
			}
			result = `${this.definitionName(outer.definition)}.${name}`;
		}
		this.#definitionNames.set(index, result);
		return result;
	}

	#typeAt(va: bigint): Il2CppTypeRef {
		const { view } = this.#image;
		const at = requireVaOffset(this.#image, va);
		const data = view.u64(at);
		const kind = (view.u32(at + 8) >>> 16) & 0xff;
		const primitive = PRIMITIVES.get(kind);
		if (primitive !== undefined) {
			return { kind: 'primitive', name: primitive };
		}
		switch (kind) {
			case 0x11:
			case 0x12: {
				return { kind: 'definition', definition: Number(data) };
			}
			case 0x15: {
				// Il2CppGenericClass: the definition's type, then the class instantiation
				const generic = requireVaOffset(this.#image, data);
				const definition = this.#typeAt(view.u64(generic));
				if (definition.kind !== 'definition') {
					throw new FormatError('generic instance of a non-definition type');
				}
				const instance = requireVaOffset(this.#image, view.u64(generic + 8));
				const argc = Number(view.i64(instance));
				const argv = requireVaOffset(this.#image, view.u64(instance + 8));
				return {
					kind: 'generic',
					definition: definition.definition,
					args: Array.from({ length: argc }, (_, i) => this.#typeAt(view.u64(argv + i * 8))),
				};
			}
			case 0x1d: {
				return { kind: 'array', element: this.#typeAt(data), rank: 1 };
			}
			case 0x14: {
				const array = requireVaOffset(this.#image, data);
				return {
					kind: 'array',
					element: this.#typeAt(view.u64(array)),
					rank: view.u8(array + 8),
				};
			}
			case 0x0f: {
				return { kind: 'pointer', element: this.#typeAt(data) };
			}
			case 0x13:
			case 0x1e: {
				return { kind: 'parameter' };
			}
			default: {
				throw new FormatError(`unknown IL2CPP type kind 0x${kind.toString(16)}`);
			}
		}
	}
}
