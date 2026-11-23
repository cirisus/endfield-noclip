/**
 * generic TypeTree-driven object reader: turns a serialized Unity object into plain JS values, using the
 * TypeTree embedded in its SerializedFile, so Hypergryph's added fields decode like any other.
 *
 * value mapping:
 *
 * - integers up to 32 bits, floats → `number`; 64-bit integers (including `m_PathID`) → `bigint`; `bool` →
 *   `boolean`; `string` → `string`
 * - `vector`/`staticvector`/`map`/`set` (a class wrapping a single `Array`) → the array itself; map entries are
 *   `{ first, second }` objects
 * - arrays of `UInt8`, `char` and `TypelessData` → `Uint8Array` views into the object bytes (no copy), and of
 *   `SInt8` → `Int8Array` views
 * - arrays of other fixed-size numeric primitives → typed arrays (copied, so they're aligned); `bool` arrays →
 *   plain arrays of `boolean`
 * - other classes → objects keyed by field name, in serialized order
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { ObjectInfo, SerializedFile, SerializedType, TypeTreeNode } from './serialized-file.ts';
import { isObject } from './values.ts';

// #region types

/** a typed array produced by the numeric-array fast path */
export type TypeTreeTypedArray =
	| Uint8Array
	| Int8Array
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

/** any value a TypeTree read can produce */
export type TypeTreeValue =
	| number
	| bigint
	| boolean
	| string
	| TypeTreeTypedArray
	| TypeTreeValue[]
	| TypeTreeObject;

/** a class instance: field name → value */
export interface TypeTreeObject {
	[field: string]: TypeTreeValue;
}

/** a TypeTree compiled into a flat op table; build once per type with {@link compileTypeTree} */
export interface CompiledTypeTree {
	/** root type name, e.g. `Mesh` */
	type: string;
	/** top-level field names, in serialized order */
	fields: string[];
	/** @internal flat compiled node table; index 0 is the root class */
	readonly ops: readonly CompiledOp[];
	/** @internal indices into `ops` of top-level fields, parallel to `fields` */
	readonly fieldIndices: readonly number[];
}

/** options for {@link readTypeTree} */
export interface ReadTypeTreeOptions {
	/** the file's byte order */
	littleEndian: boolean;
	/**
	 * resolves the payload type of a managed reference (`[SerializeReference]`), from the file's `refTypes`;
	 * objects containing non-null managed references fail to read without it
	 */
	resolveRefType?: RefTypeResolver;
}

/** @returns the compiled TypeTree of a managed reference's class, or `undefined` if unknown */
export type RefTypeResolver = (
	klassName: string,
	nameSpace: string,
	asmName: string,
) => CompiledTypeTree | undefined;

const OpKind = {
	Primitive: 0,
	PrimitiveArray: 1,
	String: 2,
	TypelessData: 3,
	ReferencedObjectData: 4,
	Array: 5,
	Class: 6,
} as const;

interface CompiledOpBase {
	type: string;
	name: string;
	/** index in `ops` immediately after this op and all its descendants */
	end: number;
	/** byte size if every instance has the same size and no internal alignment, else -1 */
	fixedSize: number;
	/** whether to 4-byte align the cursor after reading or skipping this op */
	align: boolean;
	/** whether the layout depends on data, so skipping requires reading */
	dynamic: boolean;
	/** set on a `Class` child when Hypergryph serializes it conditionally */
	condition?: (siblings: TypeTreeObject) => boolean;
}

interface PrimitiveOp extends CompiledOpBase {
	kind: typeof OpKind.Primitive | typeof OpKind.PrimitiveArray;
	primitive: Primitive;
}

interface CompoundOp extends CompiledOpBase {
	kind:
		| typeof OpKind.String
		| typeof OpKind.TypelessData
		| typeof OpKind.ReferencedObjectData
		| typeof OpKind.Array
		| typeof OpKind.Class;
}

type CompiledOp = PrimitiveOp | CompoundOp;

interface Cursor {
	bytes: Uint8Array;
	view: DataView;
	offset: number;
	littleEndian: boolean;
	resolveRefType: RefTypeResolver | undefined;
}

/**
 * fields that Hypergryph's serializer writes conditionally even though the TypeTree lists them
 * unconditionally: class type → field → predicate over the fields read before it.
 */
const HG_FIELD_CONDITIONS: Record<string, Record<string, (siblings: TypeTreeObject) => boolean>> = {
	// collision-only meshes carry cooked PhysX data instead (see AnimeStudio `Mesh.cs`)
	Mesh: { m_CompressedMesh: (siblings) => siblings.m_CollisionMeshBaked !== true },
};

/** a TypeTree node with its children, as built by {@link typeTreeHierarchy} */
export interface TreeNode {
	node: TypeTreeNode;
	children: TreeNode[];
}

// #endregion

// #region compilation

const ALIGN_FLAG = 0x4000;
const ARRAY_FLAG = 0x1;

const isArrayNode = (node: TypeTreeNode): boolean => {
	return (node.typeFlags & ARRAY_FLAG) !== 0 || node.type === 'Array';
};

/** computes `ends[i]` = index immediately after node `i`'s subtree, validating level nesting */
const computeSubtreeEnds = (nodes: readonly TypeTreeNode[]): Int32Array => {
	const ends = new Int32Array(nodes.length);
	const stack: number[] = [0];
	for (let i = 1; i < nodes.length; i++) {
		const node = nodes[i];
		let top = stack.at(-1);
		while (top !== undefined && nodes[top].level >= node.level) {
			stack.pop();
			ends[top] = i;
			top = stack.at(-1);
		}
		if (top === undefined || node.level !== nodes[top].level + 1) {
			throw new FormatError(`TypeTree node ${i} (${node.name}) has level ${node.level} without a parent`);
		}
		stack.push(i);
	}
	for (const index of stack) {
		ends[index] = nodes.length;
	}
	return ends;
};

/**
 * @param nodes a flattened TypeTree, as in `SerializedType.nodes`
 * @returns flat compiled op table for the tree
 * @throws {FormatError} if the tree is empty or uses an unknown primitive
 */
export const compileTypeTree = (nodes: readonly TypeTreeNode[]): CompiledTypeTree => {
	if (nodes.length === 0) {
		throw new FormatError('empty TypeTree (was the file built without TypeTrees?)');
	}
	const ends = computeSubtreeEnds(nodes);
	const ops: CompiledOp[] = [];

	const emitClass = (nodeIndex: number, name: string, align: boolean): number => {
		const node = nodes[nodeIndex];
		const nodeEnd = ends[nodeIndex];
		const opIndex = ops.length;
		const op: CompoundOp = {
			kind: OpKind.Class,
			type: node.type,
			name,
			end: 0,
			fixedSize: -1,
			align,
			dynamic: false,
		};
		ops.push(op);

		const conditionTable = Object.hasOwn(HG_FIELD_CONDITIONS, node.type)
			? HG_FIELD_CONDITIONS[node.type]
			: undefined;
		let dynamic = false;
		let fixedSize = 0;
		for (let child = nodeIndex + 1; child < nodeEnd; child = ends[child]) {
			const childOpIndex = emitOp(child, undefined, false);
			const childOp = ops[childOpIndex];
			if (conditionTable !== undefined && Object.hasOwn(conditionTable, childOp.name)) {
				childOp.condition = conditionTable[childOp.name];
				dynamic = true;
			}
			if (childOp.dynamic || childOp.kind === OpKind.ReferencedObjectData) {
				dynamic = true;
			}
			if (fixedSize >= 0) {
				fixedSize = childOp.fixedSize >= 0 ? fixedSize + childOp.fixedSize : -1;
			}
		}

		op.end = ops.length;
		op.dynamic = dynamic;
		op.fixedSize = align || dynamic ? -1 : fixedSize;
		return opIndex;
	};

	const emitOp = (nodeIndex: number, nameOverride: string | undefined, extraAlign: boolean): number => {
		const node = nodes[nodeIndex];
		const nodeEnd = ends[nodeIndex];
		const hasChildren = nodeIndex + 1 < nodeEnd;
		const onlyChild = hasChildren && ends[nodeIndex + 1] === nodeEnd ? nodeIndex + 1 : -1;
		const ownAlign =
			(node.metaFlag & ALIGN_FLAG) !== 0 ||
			(onlyChild >= 0 && isArrayNode(nodes[onlyChild]) && (nodes[onlyChild].metaFlag & ALIGN_FLAG) !== 0);
		const align = extraAlign || ownAlign;
		const name = nameOverride ?? node.name;

		if (isArrayNode(node)) {
			const c0 = nodeIndex + 1;
			const c1 = c0 < nodeEnd ? ends[c0] : nodeEnd;
			if (c1 >= nodeEnd || ends[c1] !== nodeEnd) {
				let count = 0;
				for (let c = nodeIndex + 1; c < nodeEnd; c = ends[c]) {
					count++;
				}
				throw new FormatError(`Array node ${node.name} has ${count} children, expected 2`);
			}
			const elemNode = nodes[c1];
			// numeric fast path
			if (c1 + 1 === ends[c1] && (elemNode.metaFlag & ALIGN_FLAG) === 0) {
				const primitive = primitiveOf(elemNode);
				const opIndex = ops.length;
				ops.push({
					kind: OpKind.PrimitiveArray,
					type: node.type,
					name,
					end: opIndex + 1,
					fixedSize: -1,
					align,
					dynamic: false,
					primitive,
				});
				return opIndex;
			}
			const opIndex = ops.length;
			const op: CompoundOp = {
				kind: OpKind.Array,
				type: node.type,
				name,
				end: 0,
				fixedSize: -1,
				align,
				dynamic: false,
			};
			ops.push(op);
			const elemOpIndex = emitOp(c1, undefined, false);
			op.end = ops.length;
			op.dynamic = ops[elemOpIndex].dynamic;
			return opIndex;
		}

		if (node.type === 'ReferencedObjectData') {
			const opIndex = ops.length;
			ops.push({
				kind: OpKind.ReferencedObjectData,
				type: 'ReferencedObjectData',
				name,
				end: opIndex + 1,
				fixedSize: -1,
				align,
				dynamic: true,
			});
			return opIndex;
		}

		if (!hasChildren && node.byteSize === 0 && !Object.hasOwn(PRIMITIVES, node.type)) {
			// a struct without serialized fields
			const opIndex = ops.length;
			ops.push({
				kind: OpKind.Class,
				type: node.type,
				name,
				end: opIndex + 1,
				fixedSize: align ? -1 : 0,
				align,
				dynamic: false,
			});
			return opIndex;
		}

		if (!hasChildren) {
			const primitive = primitiveOf(node);
			const opIndex = ops.length;
			ops.push({
				kind: OpKind.Primitive,
				type: node.type,
				name,
				end: opIndex + 1,
				fixedSize: align ? -1 : primitive.size,
				align,
				dynamic: false,
				primitive,
			});
			return opIndex;
		}

		switch (node.type) {
			case 'string': {
				// a string can wrap another string (e.g. PropertyName's `string id`)
				if (onlyChild >= 0 && nodes[onlyChild].type === 'string' && !isArrayNode(nodes[onlyChild])) {
					return emitOp(onlyChild, name, align);
				}
				const opIndex = ops.length;
				ops.push({
					kind: OpKind.String,
					type: node.type,
					name,
					end: opIndex + 1,
					fixedSize: -1,
					align,
					dynamic: false,
				});
				return opIndex;
			}
			case 'TypelessData': {
				const opIndex = ops.length;
				ops.push({
					kind: OpKind.TypelessData,
					type: 'TypelessData',
					name,
					end: opIndex + 1,
					fixedSize: -1,
					align,
					dynamic: false,
				});
				return opIndex;
			}
			default: {
				// containers (vector, staticvector, map, set, …) wrap a single Array node
				if (onlyChild >= 0 && isArrayNode(nodes[onlyChild])) {
					const opIndex = emitOp(onlyChild, name, align);
					ops[opIndex].type = node.type;
					return opIndex;
				}
				return emitClass(nodeIndex, name, align);
			}
		}
	};

	emitClass(0, nodes[0].name, false);

	const fields: string[] = [];
	const fieldIndices: number[] = [];
	const rootEnd = ops[0].end;
	for (let i = 1; i < rootEnd; i = ops[i].end) {
		fields.push(ops[i].name);
		fieldIndices.push(i);
	}

	return { type: nodes[0].type, fields, ops, fieldIndices };
};

const hierarchies = new WeakMap<readonly TypeTreeNode[], TreeNode>();

/**
 * @param nodes a flattened, non-empty TypeTree, as in `SerializedType.nodes`
 * @returns the root node with its children nested, for walking a read value alongside its types
 * @throws {FormatError} if the tree is empty or a node's level skips one
 */
export const typeTreeHierarchy = (nodes: readonly TypeTreeNode[]): TreeNode => {
	return hierarchies.getOrInsertComputed(nodes, () => {
		if (nodes.length === 0) {
			throw new FormatError('empty TypeTree (was the file built without TypeTrees?)');
		}
		return buildTree(nodes);
	});
};

const buildTree = (nodes: readonly TypeTreeNode[]): TreeNode => {
	const root: TreeNode = { node: nodes[0], children: [] };
	const stack: TreeNode[] = [root];
	for (let i = 1; i < nodes.length; i++) {
		const node = nodes[i];
		while (stack.length > 0 && (stack.at(-1)?.node.level ?? 0) >= node.level) {
			stack.pop();
		}
		const parent = stack.at(-1);
		if (parent === undefined || node.level !== parent.node.level + 1) {
			throw new FormatError(`TypeTree node ${i} (${node.name}) has level ${node.level} without a parent`);
		}
		const tree: TreeNode = { node, children: [] };
		parent.children.push(tree);
		stack.push(tree);
	}
	return root;
};

// #endregion

// #region cursor and errors

const alignCursor = (c: Cursor): void => {
	c.offset = (c.offset + 3) & ~3;
	if (c.offset > c.bytes.length) {
		throw new FormatError(`alignment ran past the end of the ${c.bytes.length}-byte object`);
	}
};

/** prepends a path segment (`name` or `[index]`) to a FormatError's `at <path>: ` prefix */
const prefixError = (error: unknown, segment: string): unknown => {
	if (!(error instanceof FormatError)) {
		return error;
	}
	const match = error.message.match(/^at (\S+): (.*)$/s);
	if (match === null) {
		return new FormatError(`at ${segment}: ${error.message}`);
	}
	const [, path, rest] = match;
	return new FormatError(`at ${segment}${path.startsWith('[') ? '' : '.'}${path}: ${rest}`);
};

const advance = (c: Cursor, size: number): number => {
	const at = c.offset;
	if (size < 0 || at + size > c.bytes.length) {
		throw new FormatError(
			`read of ${size} bytes at 0x${at.toString(16)} exceeds the ${c.bytes.length}-byte object`,
		);
	}
	c.offset = at + size;
	return at;
};

const readCount = (c: Cursor): number => {
	const count = c.view.getInt32(advance(c, 4), c.littleEndian);
	if (count < 0 || count > c.bytes.length - c.offset) {
		// every element takes at least one byte, except empty classes, which Unity doesn't emit in arrays
		throw new FormatError(`implausible array length ${count} at 0x${(c.offset - 4).toString(16)}`);
	}
	return count;
};

// #endregion

// #region primitives

interface Primitive {
	size: number;
	read: (c: Cursor, at: number) => number | bigint | boolean;
	array?: (c: Cursor, at: number, count: number) => TypeTreeTypedArray;
}

const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** copies `count` elements into a fresh aligned typed array, swapping bytes if the file's order differs */
const typedCopy = <T extends TypeTreeTypedArray>(make: (buffer: ArrayBuffer) => T, size: number) => {
	return (c: Cursor, at: number, count: number): T => {
		const copy = c.bytes.slice(at, at + count * size);
		if (c.littleEndian !== hostLittleEndian) {
			for (let i = 0; i < copy.length; i += size) {
				copy.subarray(i, i + size).reverse();
			}
		}
		return make(copy.buffer);
	};
};

const PRIMITIVES: Record<string, Primitive> = (() => {
	const u8: Primitive = {
		size: 1,
		read: (c, at) => c.view.getUint8(at),
		array: (c, at, count) => c.bytes.subarray(at, at + count),
	};
	const i8: Primitive = {
		size: 1,
		read: (c, at) => c.view.getInt8(at),
		array: (c, at, count) => new Int8Array(c.bytes.buffer, c.bytes.byteOffset + at, count),
	};
	const u16: Primitive = {
		size: 2,
		read: (c, at) => c.view.getUint16(at, c.littleEndian),
		array: typedCopy((b) => new Uint16Array(b), 2),
	};
	const i16: Primitive = {
		size: 2,
		read: (c, at) => c.view.getInt16(at, c.littleEndian),
		array: typedCopy((b) => new Int16Array(b), 2),
	};
	const u32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getUint32(at, c.littleEndian),
		array: typedCopy((b) => new Uint32Array(b), 4),
	};
	const i32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getInt32(at, c.littleEndian),
		array: typedCopy((b) => new Int32Array(b), 4),
	};
	const u64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getBigUint64(at, c.littleEndian),
		array: typedCopy((b) => new BigUint64Array(b), 8),
	};
	const i64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getBigInt64(at, c.littleEndian),
		array: typedCopy((b) => new BigInt64Array(b), 8),
	};
	const f32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getFloat32(at, c.littleEndian),
		array: typedCopy((b) => new Float32Array(b), 4),
	};
	const f64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getFloat64(at, c.littleEndian),
		array: typedCopy((b) => new Float64Array(b), 8),
	};
	const bool: Primitive = { size: 1, read: (c, at) => c.view.getUint8(at) !== 0 };
	return {
		SInt8: i8,
		UInt8: u8,
		char: u8,
		short: i16,
		SInt16: i16,
		UInt16: u16,
		'unsigned short': u16,
		int: i32,
		SInt32: i32,
		UInt32: u32,
		'unsigned int': u32,
		'Type*': u32,
		'long long': i64,
		SInt64: i64,
		UInt64: u64,
		'unsigned long long': u64,
		FileSize: u64,
		float: f32,
		double: f64,
		bool,
	};
})();

const primitiveOf = (node: TypeTreeNode): Primitive => {
	const primitive = Object.hasOwn(PRIMITIVES, node.type) ? PRIMITIVES[node.type] : undefined;
	if (primitive === undefined) {
		throw new FormatError(`unknown TypeTree primitive ${node.type} (${node.name})`);
	}
	if (node.byteSize !== primitive.size && node.byteSize !== -1) {
		throw new FormatError(
			`primitive ${node.type} ${node.name} is ${node.byteSize} bytes, expected ${primitive.size}`,
		);
	}
	return primitive;
};

// #endregion

// #region interpreter

const utf8 = new TextDecoder('utf-8');

const orphanReferencedObjectData = (): never => {
	throw new FormatError('ReferencedObjectData outside a ReferencedObject');
};

/**
 * reads a managed reference's payload: its layout is the ref type named by the sibling `type`
 * (`ReferencedManagedType { class, ns, asm }`); an empty class name is a null reference with no payload
 */
const readReferencedObjectData = (op: CompiledOp, c: Cursor, siblings: TypeTreeObject): TypeTreeObject => {
	const { type } = siblings;
	if (!isObject(type)) {
		throw new FormatError('ReferencedObjectData without a preceding ReferencedManagedType');
	}
	const { class: klass, ns, asm } = type;
	if (typeof klass !== 'string' || typeof ns !== 'string' || typeof asm !== 'string') {
		throw new FormatError('malformed ReferencedManagedType');
	}
	let value: TypeTreeObject;
	if (klass === '') {
		value = {};
	} else {
		const tree = c.resolveRefType?.(klass, ns, asm);
		if (tree === undefined) {
			throw new FormatError(`unknown managed reference type ${ns}.${klass} (${asm})`);
		}
		value = readClass(tree.ops, 0, c);
	}
	if (op.align) {
		alignCursor(c);
	}
	return value;
};

const readClass = (ops: readonly CompiledOp[], index: number, c: Cursor): TypeTreeObject => {
	const classOp = ops[index];
	const out: TypeTreeObject = {};
	for (let childIdx = index + 1; childIdx < classOp.end; childIdx = ops[childIdx].end) {
		const child = ops[childIdx];
		if (child.condition !== undefined && !child.condition(out)) {
			continue;
		}
		try {
			out[child.name] =
				child.kind === OpKind.ReferencedObjectData
					? readReferencedObjectData(child, c, out)
					: readOp(ops, childIdx, c);
		} catch (error) {
			throw prefixError(error, child.name);
		}
	}
	return out;
};

const readOp = (ops: readonly CompiledOp[], index: number, c: Cursor): TypeTreeValue => {
	const op = ops[index];
	let value: TypeTreeValue;
	switch (op.kind) {
		case OpKind.Primitive: {
			value = op.primitive.read(c, advance(c, op.primitive.size));
			break;
		}
		case OpKind.PrimitiveArray: {
			const { size, read: readOne, array } = op.primitive;
			const count = readCount(c);
			const at = advance(c, count * size);
			if (array !== undefined) {
				value = array(c, at, count);
			} else {
				const out: TypeTreeValue[] = Array.from({ length: count });
				for (let i = 0; i < count; i++) {
					out[i] = readOne(c, at + i * size);
				}
				value = out;
			}
			break;
		}
		case OpKind.String: {
			const length = readCount(c);
			const at = advance(c, length);
			value = utf8.decode(c.bytes.subarray(at, at + length));
			break;
		}
		case OpKind.TypelessData: {
			const length = readCount(c);
			const at = advance(c, length);
			value = c.bytes.subarray(at, at + length);
			break;
		}
		case OpKind.ReferencedObjectData: {
			return orphanReferencedObjectData();
		}
		case OpKind.Array: {
			const count = readCount(c);
			const elemIdx = index + 1;
			const out: TypeTreeValue[] = Array.from({ length: count });
			for (let i = 0; i < count; i++) {
				try {
					out[i] = readOp(ops, elemIdx, c);
				} catch (error) {
					throw prefixError(error, `[${i}]`);
				}
			}
			value = out;
			break;
		}
		case OpKind.Class: {
			value = readClass(ops, index, c);
			break;
		}
	}
	if (op.align) {
		alignCursor(c);
	}
	return value;
};

const skipOp = (ops: readonly CompiledOp[], index: number, c: Cursor): void => {
	const op = ops[index];
	if (op.fixedSize >= 0) {
		advance(c, op.fixedSize);
		return;
	}
	switch (op.kind) {
		case OpKind.Primitive: {
			advance(c, op.primitive.size);
			break;
		}
		case OpKind.PrimitiveArray: {
			const count = readCount(c);
			advance(c, count * op.primitive.size);
			break;
		}
		case OpKind.String:
		case OpKind.TypelessData: {
			advance(c, readCount(c));
			break;
		}
		case OpKind.ReferencedObjectData: {
			orphanReferencedObjectData();
			break;
		}
		case OpKind.Array: {
			const count = readCount(c);
			const elemIdx = index + 1;
			const elemFixed = ops[elemIdx].fixedSize;
			if (elemFixed >= 0) {
				advance(c, count * elemFixed);
			} else {
				for (let i = 0; i < count; i++) {
					skipOp(ops, elemIdx, c);
				}
			}
			break;
		}
		case OpKind.Class: {
			if (op.dynamic) {
				readClass(ops, index, c);
			} else {
				for (let childIdx = index + 1; childIdx < op.end; childIdx = ops[childIdx].end) {
					skipOp(ops, childIdx, c);
				}
			}
			break;
		}
	}
	if (op.align) {
		alignCursor(c);
	}
};

// #endregion

// #region reading

const cursor = (bytes: Uint8Array, options: ReadTypeTreeOptions): Cursor => {
	return {
		bytes,
		view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		offset: 0,
		littleEndian: options.littleEndian,
		resolveRefType: options.resolveRefType,
	};
};

/**
 * reads a whole object
 *
 * @param tree compiled TypeTree of the object's type
 * @param bytes exactly the object's bytes; `Uint8Array` results are views into it
 * @param options byte order and managed-reference resolution
 * @returns the object's fields
 * @throws {FormatError} if the data doesn't match the tree, including when bytes are left over
 */
export const readTypeTree = (
	tree: CompiledTypeTree,
	bytes: Uint8Array,
	options: ReadTypeTreeOptions,
): TypeTreeObject => {
	const c = cursor(bytes, options);
	const value = readClass(tree.ops, 0, c);
	if (c.offset !== bytes.length) {
		throw new FormatError(`${tree.type} read ${c.offset} of ${bytes.length} bytes`);
	}
	return value;
};

/**
 * reads one top-level field, skipping (without materializing, where the layout allows) the fields before it
 * and stopping immediately once the target field is read
 *
 * @param tree compiled TypeTree of the object's type
 * @param bytes the object's bytes
 * @param options byte order and managed-reference resolution
 * @param field top-level field name
 * @returns the field's value, or `undefined` if the type has no such field or the object omits it
 * @throws {FormatError} if the data doesn't match the tree
 */
export const readTypeTreeField = (
	tree: CompiledTypeTree,
	bytes: Uint8Array,
	options: ReadTypeTreeOptions,
	field: string,
): TypeTreeValue | undefined => {
	const target = tree.fields.indexOf(field);
	if (target < 0) {
		return undefined;
	}
	const c = cursor(bytes, options);
	const { ops, fieldIndices } = tree;
	// only materialize preceding fields if one of 0..target depends on sibling values
	let needsSiblings = false;
	for (let i = 0; i <= target; i++) {
		const op = ops[fieldIndices[i]];
		if (op.condition !== undefined || op.kind === OpKind.ReferencedObjectData) {
			needsSiblings = true;
			break;
		}
	}
	if (needsSiblings) {
		const out: TypeTreeObject = {};
		for (let i = 0; i <= target; i++) {
			const opIdx = fieldIndices[i];
			const op = ops[opIdx];
			if (op.condition !== undefined && !op.condition(out)) {
				continue;
			}
			try {
				out[op.name] =
					op.kind === OpKind.ReferencedObjectData
						? readReferencedObjectData(op, c, out)
						: readOp(ops, opIdx, c);
			} catch (error) {
				throw prefixError(error, op.name);
			}
		}
		return out[field];
	}
	for (let i = 0; i < target; i++) {
		skipOp(ops, fieldIndices[i], c);
	}
	const targetIdx = fieldIndices[target];
	try {
		return readOp(ops, targetIdx, c);
	} catch (error) {
		throw prefixError(error, ops[targetIdx].name);
	}
};

// #endregion

// #region SerializedFile integration

const compiledByType = new WeakMap<SerializedType, CompiledTypeTree>();
const compiledByHash = new Map<string, CompiledTypeTree>();
const compiledRefByHash = new Map<string, CompiledTypeTree>();

/**
 * packs a non-zero 16-byte `oldTypeHash` plus node count into a compact cache key so identical Unity types
 * compile once across all bundles; returns `undefined` when the hash is absent or all zeros
 */
const typeHashKey = (type: SerializedType): string | undefined => {
	const hash = type.oldTypeHash;
	if (hash === undefined || hash.length !== 16 || type.nodes.length === 0) {
		return undefined;
	}
	let nonZero = 0;
	for (let i = 0; i < 16; i++) {
		nonZero |= hash[i];
	}
	if (nonZero === 0) {
		return undefined;
	}
	return (
		String.fromCharCode(
			(hash[0] << 8) | hash[1],
			(hash[2] << 8) | hash[3],
			(hash[4] << 8) | hash[5],
			(hash[6] << 8) | hash[7],
			(hash[8] << 8) | hash[9],
			(hash[10] << 8) | hash[11],
			(hash[12] << 8) | hash[13],
			(hash[14] << 8) | hash[15],
		) + `:${type.nodes.length}`
	);
};

/**
 * @param type a type entry; its compiled tree is cached across files by `oldTypeHash` (or by identity when
 *   absent)
 * @returns the compiled TypeTree
 * @throws {FormatError} if the type has no TypeTree or it doesn't compile
 */
export const compiledTypeOf = (type: SerializedType): CompiledTypeTree => {
	const cached = compiledByType.get(type);
	if (cached !== undefined) {
		return cached;
	}
	const key = typeHashKey(type);
	if (key !== undefined) {
		const shared = compiledByHash.get(key);
		if (shared !== undefined) {
			compiledByType.set(type, shared);
			return shared;
		}
		const compiled = compileTypeTree(type.nodes);
		compiledByHash.set(key, compiled);
		compiledByType.set(type, compiled);
		return compiled;
	}
	const compiled = compileTypeTree(type.nodes);
	compiledByType.set(type, compiled);
	return compiled;
};

const EMPTY_FIELD_NAMES: ReadonlySet<string> = new Set();
const fieldNamesByType = new WeakMap<SerializedType, ReadonlySet<string>>();

/**
 * @param type a type entry, or `undefined`
 * @returns the top-level (level-1) field names of `type`, cached per type
 */
export const typeFieldNames = (type: SerializedType | undefined): ReadonlySet<string> => {
	if (type === undefined || type.nodes.length === 0) {
		return EMPTY_FIELD_NAMES;
	}
	return fieldNamesByType.getOrInsertComputed(type, () => {
		const names = new Set<string>();
		for (const node of type.nodes) {
			if (node.level === 1) {
				names.add(node.name);
			}
		}
		return names;
	});
};

/**
 * @param type a type entry, or `undefined`
 * @param names top-level field names to check for
 * @returns whether `type` declares every name in `names` at level 1
 */
export const hasTypeFields = (type: SerializedType | undefined, ...names: string[]): boolean => {
	const fields = typeFieldNames(type);
	for (const name of names) {
		if (!fields.has(name)) {
			return false;
		}
	}
	return true;
};

const readOptions = new WeakMap<SerializedFile, ReadTypeTreeOptions>();

/**
 * ref type trees end with the host's `ManagedReferencesRegistry`, but a payload doesn't repeat it (nested
 * references go into the host's registry), so it's dropped before compiling
 */
const withoutRegistry = (nodes: readonly TypeTreeNode[]): TypeTreeNode[] => {
	const out: TypeTreeNode[] = [];
	let skipBelow = -1;
	for (const node of nodes) {
		if (skipBelow >= 0 && node.level > skipBelow) {
			continue;
		}
		skipBelow = -1;
		if (node.level === 1 && node.type === 'ManagedReferencesRegistry') {
			skipBelow = node.level;
			continue;
		}
		out.push(node);
	}
	return out;
};

/**
 * @param file parsed metadata
 * @returns the read options for objects in `file`, resolving managed references against its `refTypes`
 */
export const readOptionsOf = (file: SerializedFile): ReadTypeTreeOptions => {
	return readOptions.getOrInsertComputed(file, (): ReadTypeTreeOptions => {
		const byName = new Map<string, SerializedType>();
		for (const type of file.refTypes) {
			byName.set(`${type.asmName}\0${type.nameSpace}\0${type.klassName}`, type);
		}
		const compiled = new Map<SerializedType, CompiledTypeTree>();
		const resolveRefType: RefTypeResolver = (klassName, nameSpace, asmName) => {
			const type = byName.get(`${asmName}\0${nameSpace}\0${klassName}`);
			if (type === undefined) {
				return undefined;
			}
			const local = compiled.get(type);
			if (local !== undefined) {
				return local;
			}
			const key = typeHashKey(type);
			if (key !== undefined) {
				const shared = compiledRefByHash.get(key);
				if (shared !== undefined) {
					compiled.set(type, shared);
					return shared;
				}
				const built = compileTypeTree(withoutRegistry(type.nodes));
				compiledRefByHash.set(key, built);
				compiled.set(type, built);
				return built;
			}
			const built = compileTypeTree(withoutRegistry(type.nodes));
			compiled.set(type, built);
			return built;
		};
		return { littleEndian: file.header.littleEndian, resolveRefType };
	});
};

/**
 * @param fileBytes the whole SerializedFile, or at least through the object's end
 * @param info object table entry
 * @returns a view of the object's bytes
 * @throws {FormatError} if the object ends past `fileBytes`
 */
export const objectBytes = (fileBytes: Uint8Array, info: ObjectInfo): Uint8Array => {
	if (info.byteStart + info.byteSize > fileBytes.length) {
		throw new FormatError(`object ${info.pathId} lies past the ${fileBytes.length} bytes available`);
	}
	return fileBytes.subarray(info.byteStart, info.byteStart + info.byteSize);
};

/**
 * @param file parsed metadata
 * @param info object table entry
 * @param bytes exactly the object's bytes (see {@link objectBytes})
 * @returns the object's fields
 * @throws {FormatError} if the object doesn't match its TypeTree
 */
export const readObject = (file: SerializedFile, info: ObjectInfo, bytes: Uint8Array): TypeTreeObject => {
	return readTypeTree(compiledTypeOf(info.type), bytes, readOptionsOf(file));
};

/**
 * reads one top-level field of an object without materializing the fields before it
 *
 * @param file parsed metadata
 * @param info object table entry
 * @param bytes exactly the object's bytes (see {@link objectBytes})
 * @param field top-level field name
 * @returns the field's value, or `undefined` if the type has no such field or the object omits it
 * @throws {FormatError} if the data doesn't match the object's TypeTree
 */
export const readObjectField = (
	file: SerializedFile,
	info: ObjectInfo,
	bytes: Uint8Array,
	field: string,
): TypeTreeValue | undefined => {
	return readTypeTreeField(compiledTypeOf(info.type), bytes, readOptionsOf(file), field);
};

/**
 * reads an object's `m_Name` without materializing the fields before it
 *
 * @param file parsed metadata
 * @param info object table entry
 * @param bytes exactly the object's bytes
 * @returns the name, or `undefined` if the type has no top-level `m_Name`
 * @throws {FormatError} if the data doesn't match the object's TypeTree
 */
export const peekObjectName = (
	file: SerializedFile,
	info: ObjectInfo,
	bytes: Uint8Array,
): string | undefined => {
	const value = readObjectField(file, info, bytes, 'm_Name');
	return typeof value === 'string' ? value : undefined;
};

// #endregion
