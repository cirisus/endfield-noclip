/**
 * DirectDraw Surface (DDS) DX10 container writer for pre-encoded GPU textures (BCn and uncompressed formats),
 * turning a {@link DecodedTexture} (or a single array layer / mip level) into a standard `.dds` file readable
 * by external image tools.
 */

import { FormatError } from './binary-reader.ts';
import { imageByteLength, ktx2FormatInfo, VkFormat } from './ktx2.ts';

const DDS_MAGIC = 0x20534444; // 'DDS '
const DDS_HEADER_SIZE = 124;
const DDS_PIXELFORMAT_SIZE = 32;
const DDS_DX10_SIZE = 20;
const TOTAL_HEADER_SIZE = 4 + DDS_HEADER_SIZE + DDS_DX10_SIZE;

// DDS_HEADER.dwFlags
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;

// DDS_PIXELFORMAT.dwFlags
const DDPF_FOURCC = 0x4;
const FOURCC_DX10 = 0x30315844; // 'DX10'

// DDS_HEADER.dwCaps / dwCaps2
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_CUBEMAP_ALLFACES = 0xfc00;

// D3D10_RESOURCE_DIMENSION
const DIMENSION_TEXTURE2D = 3;
const RESOURCE_MISC_TEXTURECUBE = 0x4;

/** `VkFormat` → `DXGI_FORMAT` */
const DXGI_FORMATS: ReadonlyMap<number, number> = new Map([
	[VkFormat.R8_UNORM, 61],
	[VkFormat.R8G8_UNORM, 49],
	[VkFormat.R8G8B8A8_UNORM, 28],
	[VkFormat.R8G8B8A8_SRGB, 29],
	[VkFormat.B8G8R8A8_UNORM, 87],
	[VkFormat.B8G8R8A8_SRGB, 91],
	[VkFormat.R16_UNORM, 56],
	[VkFormat.R16_SFLOAT, 54],
	[VkFormat.R16G16_UNORM, 35],
	[VkFormat.R16G16_SFLOAT, 34],
	[VkFormat.R16G16B16A16_UNORM, 11],
	[VkFormat.R16G16B16A16_SFLOAT, 10],
	[VkFormat.R32_SFLOAT, 41],
	[VkFormat.R32G32_SFLOAT, 16],
	[VkFormat.R32G32B32A32_SFLOAT, 2],
	[VkFormat.BC1_RGBA_UNORM_BLOCK, 71],
	[VkFormat.BC1_RGBA_SRGB_BLOCK, 72],
	[VkFormat.BC2_UNORM_BLOCK, 74],
	[VkFormat.BC2_SRGB_BLOCK, 75],
	[VkFormat.BC3_UNORM_BLOCK, 77],
	[VkFormat.BC3_SRGB_BLOCK, 78],
	[VkFormat.BC4_UNORM_BLOCK, 80],
	[VkFormat.BC4_SNORM_BLOCK, 81],
	[VkFormat.BC5_UNORM_BLOCK, 83],
	[VkFormat.BC5_SNORM_BLOCK, 84],
	[VkFormat.BC6H_UFLOAT_BLOCK, 95],
	[VkFormat.BC6H_SFLOAT_BLOCK, 96],
	[VkFormat.BC7_UNORM_BLOCK, 98],
	[VkFormat.BC7_SRGB_BLOCK, 99],
]);

/** minimal texture shape needed to write a DDS file */
export interface DdsInput {
	vkFormat: number;
	width: number;
	height: number;
	depth: number;
	layers: number;
	faces: number;
	/** mip levels, base first; each holds every layer and face in KTX2 level-major order */
	levels: readonly Uint8Array[];
}

/** options for {@link writeDds} */
export interface WriteDdsOptions {
	/** extract a single 2D slice (`0 .. layers * faces - 1`) as a plain 2D DDS */
	layer?: number;
	/** extract a single mip level (`0 .. levels.length - 1`) */
	mip?: number;
}

/**
 * encodes a texture (or a selected slice/mip of it) into a DX10 DDS buffer
 *
 * @param texture texture metadata and level-major mip buffers
 * @param options optional slice or mip selection
 * @returns the DDS file bytes
 * @throws {FormatError} on 3D textures, unsupported DXGI formats, or out-of-range layer/mip indices
 */
export const writeDds = (texture: DdsInput, options: WriteDdsOptions = {}): Uint8Array => {
	if (texture.depth > 1) {
		throw new FormatError('DDS export does not support 3D textures');
	}
	const dxgiFormat = DXGI_FORMATS.get(texture.vkFormat);
	const formatInfo = ktx2FormatInfo(texture.vkFormat);
	if (dxgiFormat === undefined || formatInfo === undefined) {
		throw new FormatError(`VkFormat ${texture.vkFormat} has no DXGI_FORMAT mapping`);
	}

	const totalSlices = texture.layers * texture.faces;
	const mipCount = texture.levels.length;
	if (mipCount === 0) {
		throw new FormatError('texture has no mip levels');
	}

	let firstSlice = 0;
	let sliceCount = totalSlices;
	if (options.layer !== undefined) {
		if (!Number.isInteger(options.layer) || options.layer < 0 || options.layer >= totalSlices) {
			throw new FormatError(`--layer must be between 0 and ${totalSlices - 1}, got ${options.layer}`);
		}
		firstSlice = options.layer;
		sliceCount = 1;
	}

	let firstMip = 0;
	let outMips = mipCount;
	if (options.mip !== undefined) {
		if (!Number.isInteger(options.mip) || options.mip < 0 || options.mip >= mipCount) {
			throw new FormatError(`--mip must be between 0 and ${mipCount - 1}, got ${options.mip}`);
		}
		firstMip = options.mip;
		outMips = 1;
	}

	const width = Math.max(1, texture.width >> firstMip);
	const height = Math.max(1, texture.height >> firstMip);
	const isCubemap = options.layer === undefined && texture.faces === 6;
	const arraySize = isCubemap ? texture.layers : sliceCount;
	const isCompressed = formatInfo.blockWidth > 1 || formatInfo.blockHeight > 1;
	const pitchOrLinearSize = isCompressed
		? imageByteLength(formatInfo, width, height)
		: Math.ceil(width / formatInfo.blockWidth) * formatInfo.blockBytes;

	// DDS stores slices in array-major order: for each slice, all its mips largest-first
	const sliceMips: Uint8Array[] = [];
	let payloadBytes = 0;
	for (let slice = firstSlice; slice < firstSlice + sliceCount; slice++) {
		for (let m = firstMip; m < firstMip + outMips; m++) {
			const level = texture.levels[m];
			const mw = Math.max(1, texture.width >> m);
			const mh = Math.max(1, texture.height >> m);
			const sliceBytes = imageByteLength(formatInfo, mw, mh);
			const offset = slice * sliceBytes;
			if (offset + sliceBytes > level.byteLength) {
				throw new FormatError(
					`mip ${m} slice ${slice} exceeds level buffer (${offset + sliceBytes} > ${level.byteLength})`,
				);
			}
			const view = level.subarray(offset, offset + sliceBytes);
			sliceMips.push(view);
			payloadBytes += view.byteLength;
		}
	}

	const out = new Uint8Array(TOTAL_HEADER_SIZE + payloadBytes);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

	let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
	flags |= isCompressed ? DDSD_LINEARSIZE : DDSD_PITCH;
	if (outMips > 1) {
		flags |= DDSD_MIPMAPCOUNT;
	}

	let caps = DDSCAPS_TEXTURE;
	if (outMips > 1 || sliceCount > 1) {
		caps |= DDSCAPS_COMPLEX;
	}
	if (outMips > 1) {
		caps |= DDSCAPS_MIPMAP;
	}
	const caps2 = isCubemap ? DDSCAPS2_CUBEMAP | DDSCAPS2_CUBEMAP_ALLFACES : 0;

	view.setUint32(0, DDS_MAGIC, true);
	view.setUint32(4, DDS_HEADER_SIZE, true);
	view.setUint32(8, flags, true);
	view.setUint32(12, height, true);
	view.setUint32(16, width, true);
	view.setUint32(20, pitchOrLinearSize, true);
	view.setUint32(24, 0, true); // dwDepth
	view.setUint32(28, outMips, true);
	// DDS_PIXELFORMAT at offset 76
	view.setUint32(76, DDS_PIXELFORMAT_SIZE, true);
	view.setUint32(80, DDPF_FOURCC, true);
	view.setUint32(84, FOURCC_DX10, true);
	// caps at offset 108
	view.setUint32(108, caps, true);
	view.setUint32(112, caps2, true);
	// DDS_HEADER_DXT10 at offset 128
	view.setUint32(128, dxgiFormat, true);
	view.setUint32(132, DIMENSION_TEXTURE2D, true);
	view.setUint32(136, isCubemap ? RESOURCE_MISC_TEXTURECUBE : 0, true);
	view.setUint32(140, arraySize, true);
	view.setUint32(144, 0, true); // miscFlags2

	let cursor = TOTAL_HEADER_SIZE;
	for (const chunk of sliceMips) {
		out.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
	return out;
};
