/**
 * converts a TypeTree read into plain JSON, guided by the field types: Unity's math structs become arrays and
 * C# `bool`s (serialized as `UInt8`) become booleans. meant for configuration objects whose fields are copied
 * as they are, like the environment's `HG*Config` sections.
 *
 * - `UInt8` → `boolean`; other numbers stay numbers (64-bit integers are converted)
 * - `ColorRGBA` → `[r, g, b, a]`; `Vector2f`/`Vector3f`/`Vector4f` → `[x, y(, z(, w))]`; `Quaternionf` → `[x,
 *   y, z, w]`; `Matrix4x4f` → 16 numbers in serialized order (`e00 e01 e02 e03 e10 …`, row-major);
 *   `SphericalHarmonicsL2` → its 27 coefficients in serialized order
 * - `PPtr<T>` → `null` where {@link PlainOptions.keepPPtr} accepts it (and listed in
 *   {@link PlainResult.pptrs}), else dropped
 * - SRP volume parameters (`*Parameter` with `overrideState`, `m_Value`) → their `m_Value`
 * - arrays → dropped; so are fields {@link PlainOptions.dropField} rejects
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { TypeTreeNode } from './serialized-file.ts';
import { typeTreeHierarchy, type TreeNode, type TypeTreeObject, type TypeTreeValue } from './type-tree.ts';
import { asPPtr, isObject, type PPtr } from './values.ts';

/** a plain JSON value */
export type PlainValue = number | boolean | string | null | number[] | PlainObject;

/** a plain JSON object */
export interface PlainObject {
	[field: string]: PlainValue;
}

/** what to keep */
export interface PlainOptions {
	/**
	 * @param type the PPtr's type name, e.g. `PPtr<$Cubemap>`
	 * @param name the field name
	 * @returns whether to keep the pointer (as `null`, to be filled in by the caller)
	 */
	keepPPtr: (type: string, name: string) => boolean;
	/**
	 * @param name a field name, at any depth
	 * @param type its type name
	 * @returns whether to leave the field out
	 */
	dropField: (name: string, type: string) => boolean;
}

/** a converted object and the pointers it kept */
export interface PlainResult {
	value: PlainObject;
	/** kept PPtrs, by field path from the converted object */
	pptrs: { path: string[]; type: string; pptr: PPtr }[];
}

/** struct types turned into arrays, with their component names in order */
const STRUCTS: Record<string, readonly string[]> = {
	ColorRGBA: ['r', 'g', 'b', 'a'],
	Vector2f: ['x', 'y'],
	Vector3f: ['x', 'y', 'z'],
	Vector4f: ['x', 'y', 'z', 'w'],
	Quaternionf: ['x', 'y', 'z', 'w'],
};

/**
 * @param nodes the object's flattened TypeTree (`SerializedType.nodes`)
 * @param value the object as read with that TypeTree
 * @param options what to keep
 * @returns the plain object, and the pointers kept
 * @throws {FormatError} if the value doesn't match the tree
 */
export const toPlainObject = (
	nodes: readonly TypeTreeNode[],
	value: TypeTreeObject,
	options: PlainOptions,
): PlainResult => {
	const pptrs: PlainResult['pptrs'] = [];
	return { value: convertClass(typeTreeHierarchy(nodes), value, [], options, pptrs), pptrs };
};

const convertClass = (
	tree: TreeNode,
	value: TypeTreeObject,
	path: string[],
	options: PlainOptions,
	pptrs: PlainResult['pptrs'],
): PlainObject => {
	const out: PlainObject = {};
	for (const child of tree.children) {
		const { name, type } = child.node;
		if (options.dropField(name, type) || !Object.hasOwn(value, name)) {
			continue;
		}
		path.push(name);
		const converted = convertValue(child, value[name], path, options, pptrs);
		path.pop();
		if (converted !== undefined) {
			out[name] = converted;
		}
	}
	return out;
};

const convertValue = (
	tree: TreeNode,
	value: TypeTreeValue,
	path: string[],
	options: PlainOptions,
	pptrs: PlainResult['pptrs'],
): PlainValue | undefined => {
	const { type, name } = tree.node;
	if (type.startsWith('PPtr<')) {
		if (!options.keepPPtr(type, name)) {
			return undefined;
		}
		pptrs.push({ path: [...path], type, pptr: asPPtr(value) });
		return null;
	}
	const components = STRUCTS[type];
	if (components !== undefined) {
		return components.map((component) => numberAt(value, component, path));
	}
	// SRP volume parameters (`BoolParameter`, `ClampedFloatParameter`, …) wrap `overrideState` and `m_Value`
	if (type.endsWith('Parameter') && isObject(value) && Object.hasOwn(value, 'm_Value')) {
		const inner = tree.children.find((child) => child.node.name === 'm_Value');
		if (inner !== undefined) {
			return convertValue(inner, value.m_Value, path, options, pptrs);
		}
	}
	switch (type) {
		case 'UInt8': {
			return numberOf(value, path) !== 0;
		}
		case 'Matrix4x4f':
		case 'SphericalHarmonicsL2': {
			// the fields are `e00`…`e33` / `sh[ 0]`…`sh[26]`, in serialized order
			return tree.children.map((child) => numberAt(value, child.node.name, path));
		}
		default: {
			break;
		}
	}
	if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		return undefined;
	}
	if (isObject(value)) {
		return convertClass(tree, value, path, options, pptrs);
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return value;
};

/** what a converted field holds, by its TypeTree type */
export type PlainFieldKind = 'float' | 'integer' | 'boolean' | 'string' | 'reference';

/**
 * per field of a converted object, what it holds: a kind for primitives, math structs (their numbers are all
 * floats), matrices and SH, and pointers; nested kinds for nested objects
 */
export interface PlainKinds {
	[field: string]: PlainFieldKind | PlainKinds;
}

const FLOAT_TYPES = new Set(['float', 'double']);
const INTEGER_TYPES = new Set([
	'int',
	'unsigned int',
	'SInt8',
	'SInt16',
	'UInt16',
	'SInt32',
	'UInt32',
	'SInt64',
	'UInt64',
	'short',
	'unsigned short',
	'long long',
	'unsigned long long',
	'char',
]);

/**
 * describes the fields {@link toPlainObject} would produce for objects of a TypeTree, from the types alone.
 * fields it drops (arrays, rejected fields and pointers) are absent
 *
 * @param nodes the objects' flattened TypeTree
 * @param options what to keep, as for {@link toPlainObject}
 * @returns the kinds
 * @throws {FormatError} if the tree is empty
 */
export const plainKinds = (nodes: readonly TypeTreeNode[], options: PlainOptions): PlainKinds =>
	kindsOfClass(typeTreeHierarchy(nodes), options);

const kindsOfClass = (tree: TreeNode, options: PlainOptions): PlainKinds => {
	const out: PlainKinds = {};
	for (const child of tree.children) {
		const { name, type } = child.node;
		if (options.dropField(name, type)) {
			continue;
		}
		const kind = kindOf(child, options);
		if (kind !== undefined) {
			out[name] = kind;
		}
	}
	return out;
};

const kindOf = (tree: TreeNode, options: PlainOptions): PlainFieldKind | PlainKinds | undefined => {
	const { type, name } = tree.node;
	if (type.startsWith('PPtr<')) {
		return options.keepPPtr(type, name) ? 'reference' : undefined;
	}
	if (Object.hasOwn(STRUCTS, type) || type === 'Matrix4x4f' || type === 'SphericalHarmonicsL2') {
		return 'float';
	}
	if (type.endsWith('Parameter')) {
		const inner = tree.children.find((child) => child.node.name === 'm_Value');
		if (inner !== undefined) {
			return kindOf(inner, options);
		}
	}
	if (type === 'UInt8' || type === 'bool') {
		return 'boolean';
	}
	if (type === 'string') {
		return 'string';
	}
	if (tree.children.length === 0) {
		if (FLOAT_TYPES.has(type)) {
			return 'float';
		}
		return INTEGER_TYPES.has(type) ? 'integer' : undefined;
	}
	if (isArray(tree) || (tree.children.length === 1 && isArray(tree.children[0]))) {
		return undefined;
	}
	return kindsOfClass(tree, options);
};

const isArray = (tree: TreeNode): boolean => (tree.node.typeFlags & 1) !== 0 || tree.node.type === 'Array';

const numberAt = (value: TypeTreeValue, field: string, path: string[]): number => {
	if (!isObject(value)) {
		throw new FormatError(`${path.join('.')} is not an object`);
	}
	path.push(field);
	const result = numberOf(value[field], path);
	path.pop();
	return result;
};

const numberOf = (value: TypeTreeValue | undefined, path: string[]): number => {
	switch (typeof value) {
		case 'number': {
			return value;
		}
		case 'bigint': {
			return Number(value);
		}
		case 'boolean': {
			return value ? 1 : 0;
		}
		default: {
			throw new FormatError(`${path.join('.')} is not a number`);
		}
	}
};
