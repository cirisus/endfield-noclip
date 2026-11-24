/**
 * declarative dot-path filter and field-projection helpers shared by CLI query commands (`audit`, `bundle`,
 * `scene`, `inspect`). avoids ad-hoc `node -e` scripts while staying strictly data-driven.
 */

export type WhereOp = '=' | '!=' | '~' | '!~' | '>' | '>=' | '<' | '<=' | 'truthy' | 'falsy';

export interface WherePredicate {
	op: WhereOp;
	path: string;
	raw: string;
	regex?: RegExp;
	num?: number;
}

const OP_RE = /^([^=!~<>]+?)(!=|!~|>=|<=|=|~|>|<)(.*)$/;

const parseOp = (raw: string): WhereOp => {
	switch (raw) {
		case '=':
		case '!=':
		case '~':
		case '!~':
		case '>':
		case '>=':
		case '<':
		case '<=': {
			return raw;
		}
		default: {
			throw new Error(`unknown --where operator: ${raw}`);
		}
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toText = (value: unknown): string => {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	return JSON.stringify(value);
};

/**
 * parses one `--where` expression: `path=val`, `path!=val`, `path~re`, `path!~re`, `path>n`, `path>=n`,
 * `path<n`, `path<=n`, `path` (truthy), or `!path` (falsy/missing)
 *
 * @param expr raw filter expression
 * @returns compiled predicate
 * @throws {Error} on empty path, invalid regex, or non-numeric comparison operand
 */
export const parseWhere = (expr: string): WherePredicate => {
	const trimmed = expr.trim();
	if (trimmed.length === 0) {
		throw new Error('--where expression cannot be empty');
	}
	const match = OP_RE.exec(trimmed);
	if (match === null) {
		if (trimmed.startsWith('!')) {
			const path = trimmed.slice(1).trim();
			if (path.length === 0) {
				throw new Error(`invalid --where expression: ${expr}`);
			}
			return { op: 'falsy', path, raw: '' };
		}
		return { op: 'truthy', path: trimmed, raw: '' };
	}
	const path = match[1].trim();
	const op = parseOp(match[2]);
	const raw = match[3].trim();
	if (path.length === 0) {
		throw new Error(`invalid --where expression: ${expr}`);
	}
	if (op === '~' || op === '!~') {
		return { op, path, raw, regex: new RegExp(raw, 'i') };
	}
	if (op === '>' || op === '>=' || op === '<' || op === '<=') {
		const num = Number(raw);
		if (raw.length === 0 || !Number.isFinite(num)) {
			throw new Error(`--where ${op} expects a finite number, got ${JSON.stringify(raw)}`);
		}
		return { op, path, raw, num };
	}
	return { op, path, raw };
};

/**
 * parses a list of `--where` expressions
 *
 * @param exprs raw expressions (may be undefined)
 * @returns compiled predicates
 */
export const parseWhereList = (exprs: readonly string[] | undefined): WherePredicate[] => {
	return exprs === undefined ? [] : exprs.map(parseWhere);
};

/**
 * extracts all values reachable along a dot-separated path (expanding arrays automatically, with or without
 * `[]` suffix on segments)
 *
 * @param root root object or value
 * @param path dot-separated path (e.g. `SubModule.subEmitters[].emitProbability`)
 * @returns all leaf values reached (empty if any segment is missing)
 */
export const getPathValues = (root: unknown, path: string): unknown[] => {
	const segments = path
		.split('.')
		.map((part) => (part.endsWith('[]') ? part.slice(0, -2) : part))
		.filter(Boolean);
	let current: unknown[] = [root];
	for (const segment of segments) {
		const next: unknown[] = [];
		for (const item of current) {
			collectSegment(item, segment, next);
		}
		if (next.length === 0) {
			return [];
		}
		current = next;
	}
	// flatten one level of leaf arrays so `keywords~_USE_MAIN2` and `tags=foo` match elements directly
	const out: unknown[] = [];
	for (const item of current) {
		if (Array.isArray(item)) {
			out.push(...item);
		} else {
			out.push(item);
		}
	}
	return out;
};

const collectSegment = (value: unknown, segment: string, out: unknown[]): void => {
	if (value === null || value === undefined) {
		return;
	}
	if (Array.isArray(value)) {
		if (/^\d+$/.test(segment)) {
			const idx = Number(segment);
			if (idx < value.length) {
				out.push(value[idx]);
			}
			return;
		}
		for (const elem of value) {
			collectSegment(elem, segment, out);
		}
		return;
	}
	if (isRecord(value) && segment in value) {
		out.push(value[segment]);
	}
};

const isTruthy = (value: unknown): boolean => {
	if (
		value === null ||
		value === undefined ||
		value === false ||
		value === 0 ||
		value === 0n ||
		value === ''
	) {
		return false;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return true;
};

const toNumber = (value: unknown): number | null => {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
};

const equalsValue = (value: unknown, raw: string): boolean => {
	if (raw === 'null') {
		return value === null || value === undefined;
	}
	if (raw === 'true' || raw === 'false') {
		if (typeof value === 'boolean') {
			return value === (raw === 'true');
		}
		if (typeof value === 'number') {
			return (value !== 0) === (raw === 'true');
		}
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		const n = Number(raw);
		if (raw.length > 0 && Number.isFinite(n)) {
			return Number(value) === n;
		}
		return String(value) === raw;
	}
	if (typeof value === 'string') {
		return value.toLowerCase() === raw.toLowerCase();
	}
	return toText(value).toLowerCase() === raw.toLowerCase();
};

const matchesOne = (root: unknown, predicate: WherePredicate): boolean => {
	const values = getPathValues(root, predicate.path);
	switch (predicate.op) {
		case 'truthy': {
			return values.some(isTruthy);
		}
		case 'falsy': {
			return values.every((v) => !isTruthy(v));
		}
		case '=': {
			return values.some((v) => equalsValue(v, predicate.raw));
		}
		case '!=': {
			return values.every((v) => !equalsValue(v, predicate.raw));
		}
		case '~': {
			return values.some((v) => v !== null && v !== undefined && predicate.regex!.test(toText(v)));
		}
		case '!~': {
			return values.every((v) => v === null || v === undefined || !predicate.regex!.test(toText(v)));
		}
		case '>': {
			return values.some((v) => {
				const n = toNumber(v);
				return n !== null && n > predicate.num!;
			});
		}
		case '>=': {
			return values.some((v) => {
				const n = toNumber(v);
				return n !== null && n >= predicate.num!;
			});
		}
		case '<': {
			return values.some((v) => {
				const n = toNumber(v);
				return n !== null && n < predicate.num!;
			});
		}
		case '<=': {
			return values.some((v) => {
				const n = toNumber(v);
				return n !== null && n <= predicate.num!;
			});
		}
	}
};

/**
 * tests whether a row matches all `--where` predicates (logical AND)
 *
 * @param row object to test
 * @param predicates compiled predicates
 * @returns true when every predicate matches
 */
export const matchesWhere = (row: unknown, predicates: readonly WherePredicate[]): boolean => {
	return predicates.every((predicate) => matchesOne(row, predicate));
};

/**
 * extracts the raw value at a dot-path without flattening leaf arrays, for `--pick` projection
 *
 * @param root root object
 * @param path dot-separated path
 * @returns projected value (or `undefined` when absent)
 */
const projectPath = (root: unknown, path: string): unknown => {
	const segments = path
		.split('.')
		.map((part) => (part.endsWith('[]') ? part.slice(0, -2) : part))
		.filter(Boolean);
	let current: unknown = root;
	for (let i = 0; i < segments.length; i++) {
		if (current === null || current === undefined) {
			return undefined;
		}
		const segment = segments[i];
		if (Array.isArray(current)) {
			if (/^\d+$/.test(segment)) {
				current = current[Number(segment)];
			} else {
				const rest = segments.slice(i).join('.');
				return current.map((elem) => projectPath(elem, rest));
			}
		} else if (isRecord(current) && segment in current) {
			current = current[segment];
		} else {
			return undefined;
		}
	}
	return current;
};

/**
 * projects an object to only the requested dot-paths (for `--pick`)
 *
 * @param row source object
 * @param paths dot-paths to retain
 * @returns new plain object keyed by each requested path
 */
export const pickFields = (row: unknown, paths: readonly string[]): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const path of paths) {
		out[path] = projectPath(row, path);
	}
	return out;
};
