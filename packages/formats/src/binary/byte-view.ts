import { FormatError } from './binary-reader.ts';

/**
 * bounds-checked little-endian reads at absolute offsets, for formats addressed by stored offsets rather than
 * read front to back (`BinaryReader` covers cursor-based reads). every read throws a {@link FormatError}
 * instead of a `RangeError` when it leaves the buffer.
 */
export class ByteView {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	readonly #label: string;

	/**
	 * @param bytes buffer to read; not copied
	 * @param label format name used in error messages
	 */
	constructor(bytes: Uint8Array, label: string) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#label = label;
	}

	get length(): number {
		return this.bytes.byteLength;
	}

	u8(at: number): number {
		this.check(at, 1);
		return this.bytes[at];
	}

	i8(at: number): number {
		this.check(at, 1);
		return this.view.getInt8(at);
	}

	u16(at: number): number {
		this.check(at, 2);
		return this.view.getUint16(at, true);
	}

	i16(at: number): number {
		this.check(at, 2);
		return this.view.getInt16(at, true);
	}

	u32(at: number): number {
		this.check(at, 4);
		return this.view.getUint32(at, true);
	}

	i32(at: number): number {
		this.check(at, 4);
		return this.view.getInt32(at, true);
	}

	u64(at: number): bigint {
		this.check(at, 8);
		return this.view.getBigUint64(at, true);
	}

	i64(at: number): bigint {
		this.check(at, 8);
		return this.view.getBigInt64(at, true);
	}

	/**
	 * reads a signed 64-bit integer that must fit in a JS number
	 *
	 * @throws {FormatError} if the value exceeds `Number.MAX_SAFE_INTEGER`
	 */
	i64Number(at: number): number {
		this.check(at, 8);
		const lo = this.view.getUint32(at, true);
		const hi = this.view.getInt32(at + 4, true);
		if (hi < 0x20_0000 && (hi > -0x20_0000 || (hi === -0x20_0000 && lo !== 0))) {
			return hi * 0x1_0000_0000 + lo;
		}
		const value = this.view.getBigInt64(at, true);
		throw new FormatError(
			`${this.#label} 64-bit value ${value} at 0x${at.toString(16)} isn't a safe integer`,
		);
	}

	f32(at: number): number {
		this.check(at, 4);
		return this.view.getFloat32(at, true);
	}

	f64(at: number): number {
		this.check(at, 8);
		return this.view.getFloat64(at, true);
	}

	/** @returns three consecutive little-endian floats at `at` */
	vec3(at: number): [number, number, number] {
		this.check(at, 12);
		return [
			this.view.getFloat32(at, true),
			this.view.getFloat32(at + 4, true),
			this.view.getFloat32(at + 8, true),
		];
	}

	/** @returns four consecutive little-endian floats at `at` */
	vec4(at: number): [number, number, number, number] {
		this.check(at, 16);
		return [
			this.view.getFloat32(at, true),
			this.view.getFloat32(at + 4, true),
			this.view.getFloat32(at + 8, true),
			this.view.getFloat32(at + 12, true),
		];
	}

	/** @returns a view (not a copy) of `size` bytes at `at` */
	subarray(at: number, size: number): Uint8Array {
		this.check(at, size);
		return this.bytes.subarray(at, at + size);
	}

	/** @returns `size` bytes at `at` decoded as UTF-8 */
	utf8(at: number, size: number): string {
		return utf8.decode(this.subarray(at, size));
	}

	/** reads a NUL-terminated UTF-8 string; returns it and the offset after the terminator */
	cString(at: number): [value: string, end: number] {
		this.check(at, 0);
		const end = this.bytes.indexOf(0, at);
		if (end < 0) {
			throw new FormatError(`unterminated ${this.#label} string at ${at}`);
		}
		return [utf8.decode(this.bytes.subarray(at, end)), end + 1];
	}

	/** @throws {FormatError} if `[at, at + size)` isn't inside the buffer */
	check(at: number, size: number): void {
		if (!(at >= 0 && size >= 0 && at + size <= this.bytes.byteLength)) {
			throw new FormatError(`${this.#label} read of ${size} bytes at 0x${at.toString(16)} is out of bounds`);
		}
	}
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
