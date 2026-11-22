import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

/** an interactive template's base model, before its other components */
export interface InteractiveBaseModel {
	id: string;
	scale: number;
}

/**
 * reads an interactive template's base model from its leading model component. the other components remain
 * opaque
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @returns the base model, or `null` for a template that names none
 * @throws {FormatError} for a different template/component layout
 */
export const readInteractiveBaseModel = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveBaseModel | null => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const expect = (value: number, expected: number): void => {
		if (value !== expected) {
			throw new FormatError(`unsupported interactive model prefix at ${r.offset}`);
		}
	};
	expect(r.u8(), 26);
	string(r.i32());
	r.i32();
	string(r.i32());
	const tags = r.i32();
	if (tags < 0 || tags > 65536) {
		throw new FormatError('invalid interactive born tags');
	}
	r.skip(tags * 4);
	const components = r.i32();
	if (components < 2 || components > 1024) {
		throw new FormatError('interactive model components are missing');
	}
	expect(r.u8(), 150);
	expect(r.u8(), 0);
	expect(r.u8(), 250);
	expect(r.u16(), 318);
	expect(r.u8(), 4);
	r.f32();
	if (r.u8() > 1) {
		throw new FormatError('invalid model fade boolean');
	}
	const id = string(r.i32()),
		scale = r.f32();
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new FormatError('invalid interactive model scale');
	}
	return id ? { id, scale } : null;
};

/** the interactive table: which template file each placeable interactive id instantiates */
export interface InteractiveTable {
	/** template id → template data path */
	templatePaths: Map<string, string>;
	/** interactive id (a LevelData row's template key) → template id */
	templates: Map<string, string>;
}

/**
 * reads `Interactive/InteractiveTable.json`
 *
 * @param bytes pooled MemoryPack table
 * @param string resolves pooled string ids
 * @returns template paths and the template of every interactive id
 * @throws {FormatError} for a different layout
 */
export const readInteractiveTable = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveTable => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const marker = (n: number): void => {
		if (r.u8() !== n) {
			throw new FormatError(`unsupported interactive table at ${r.offset - 1}`);
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < 0 || n > 100_000) {
			throw new FormatError(`invalid interactive table count ${n}`);
		}
		return n;
	};
	const required = (): string => {
		const value = string(r.i32());
		if (!value) {
			throw new FormatError(`empty interactive table string at ${r.offset - 4}`);
		}
		return value;
	};
	marker(2);
	const templatePaths = new Map<string, string>();
	for (let i = count(); i > 0; i--) {
		templatePaths.set(required(), required());
	}
	const templates = new Map<string, string>();
	for (let i = count(); i > 0; i--) {
		const id = required();
		marker(1);
		templates.set(id, required());
	}
	if (r.remaining !== 0) {
		throw new FormatError('trailing interactive table bytes');
	}
	return { templatePaths, templates };
};

/**
 * reads the model overrides of a template's variants. the variant table sits at the end of the template,
 * after components and action graphs whose layouts aren't decoded, so it is located from the end: the table,
 * then the template's temporary properties and two flags must end exactly at the end of the file, and its
 * keys must be exactly `variants`. any other number of matching positions is an error
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @param variants the interactive ids that instantiate this template, without the template's own id
 * @returns the model id of each variant that overrides the template's model, or `null` where it overrides it
 *   with no model (its interactive draws nothing of its own); variants that keep the template's model are
 *   absent
 * @throws {FormatError} when no single position frames the table
 */
export const readInteractiveVariantModels = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
	variants: ReadonlySet<string>,
): Map<string, string | null> => {
	if (variants.size === 0) {
		return new Map();
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// most candidate positions hold no valid string id at all
	const lookup = (id: number): string | null => {
		try {
			return string(id);
		} catch (error) {
			if (error instanceof FormatError) {
				return null;
			}
			throw error;
		}
	};
	let found: Map<string, string | null | undefined> | null = null;
	// a table header is the dictionary wrapper's member count (1), the entry count and a known first key;
	// the table's nine-byte header and the six-byte remainder bound the last position
	for (let at = bytes.length - 15; at >= 0; at--) {
		if (
			bytes[at] !== 1 ||
			view.getInt32(at + 1, true) !== variants.size ||
			!variants.has(lookup(view.getInt32(at + 5, true)) ?? '')
		) {
			continue;
		}
		const models = readVariantTail(new BinaryReader(bytes, { offset: at, littleEndian: true }), string);
		if (models === null || models.size !== variants.size || !models.keys().every((id) => variants.has(id))) {
			continue;
		}
		if (found !== null) {
			throw new FormatError('ambiguous interactive variant table');
		}
		found = models;
	}
	if (found === null) {
		throw new FormatError('interactive variant table not found');
	}
	const overrides = new Map<string, string | null>();
	for (const [id, model] of found) {
		if (model !== undefined) {
			overrides.set(id, model);
		}
	}
	return overrides;
};

/**
 * reads the variant table through the end of the template, or returns `null` where it doesn't frame. each
 * variant maps to its model override: a model id, `null` for an enabled empty override, `undefined` for none
 */
const readVariantTail = (
	r: BinaryReader,
	string: (id: number) => string | null,
): Map<string, string | null | undefined> | null => {
	class Mismatch extends Error {}
	const fail = (): never => {
		throw new Mismatch();
	};
	const marker = (n: number): void => {
		if (r.u8() !== n) {
			fail();
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < -1 || n > 100_000) {
			fail();
		}
		return Math.max(n, 0);
	};
	const list = (read: () => void): void => {
		for (let i = count(); i > 0; i--) {
			read();
		}
	};
	const bool = (): boolean => {
		const value = r.u8();
		if (value > 1) {
			fail();
		}
		return value === 1;
	};
	const str = (): string | null => string(r.i32());
	// a nullable object with `members` members
	const nullable = (members: number, read: () => void): void => {
		const n = r.u8();
		if (n === 255) {
			return;
		}
		if (n !== members) {
			fail();
		}
		read();
	};
	// a managed Optional<T>: an object of (enabled, value)
	// `undefined` when absent or disabled
	const optional = <T>(read: () => T): T | undefined => {
		const n = r.u8();
		if (n === 255) {
			return undefined;
		}
		if (n !== 2) {
			fail();
		}
		const enabled = bool();
		const value = read();
		return enabled ? value : undefined;
	};
	// an unmanaged Optional<T> of a four-byte value: enabled, padding, value
	const optionalValue = (): void => {
		bool();
		r.skip(7);
	};
	const param = (): void => {
		marker(2);
		str();
		nullable(2, () => {
			r.i32();
			list(() => {
				marker(2);
				r.i64();
				str();
			});
		});
	};
	try {
		const models = new Map<string, string | null | undefined>();
		marker(1);
		for (let i = count(); i > 0; i--) {
			const id = str();
			if (id === null || models.has(id)) {
				return null;
			}
			// members in name order: aoiRadiusType, bornTag, componentDiffProperties, delayRecyclePerformTime,
			// delayToRecycleTime, diffProperties, facOccDis, factionIndex, globalVarDiff, hideInDialog,
			// mapVarDiff, modelId, mountPoints, relatedGuideTimestampGameVar
			marker(14);
			optionalValue();
			optional(() => r.skip(count() * 4));
			nullable(1, () =>
				list(() => {
					str();
					nullable(1, () => list(param));
				}),
			);
			optionalValue();
			optionalValue();
			list(param);
			optionalValue();
			optionalValue();
			list(param);
			bool();
			bool();
			list(param);
			const model = optional(str);
			optional(() =>
				list(() =>
					nullable(2, () => {
						r.i32();
						str();
					}),
				),
			);
			optional(() =>
				list(() => {
					str();
				}),
			);
			// an enabled empty override means no model, not the template's
			models.set(id, model === undefined ? undefined : model || null);
		}
		list(param);
		bool();
		bool();
		return r.remaining === 0 ? models : null;
	} catch (error) {
		if (error instanceof Mismatch || error instanceof FormatError) {
			return null;
		}
		throw error;
	}
};
