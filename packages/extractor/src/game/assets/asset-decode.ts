import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type ShaderSummary, summarizeShader } from '@endfield-noclip/formats/unity/material';
import { decodeMesh, type DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { isTextureClass, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { decodeTexture, type DecodedTexture } from '@endfield-noclip/formats/unity/texture';
import { isObject, streamingInfo } from '@endfield-noclip/formats/unity/values';

import { type AssetResolver, objectKey, type ObjectRef } from './assets.ts';

// decoders bound to an AssetResolver: they follow m_StreamData and PPtrs across bundles

/**
 * @param resolver asset resolver
 * @param ref a Mesh object
 * @returns the decoded mesh
 * @throws {FormatError} if the object isn't a mesh or doesn't decode
 */
export const loadMesh = async (resolver: AssetResolver, ref: ObjectRef): Promise<DecodedMesh> => {
	if (ref.info.classId !== UnityClass.Mesh) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Mesh`);
	}
	const mesh = await resolver.read(ref);
	const stream = streamingInfo(mesh);
	return decodeMesh(mesh, stream && (await resolver.streamData(ref, stream)));
};

/**
 * @param resolver asset resolver
 * @param ref a texture object (Texture2D, Cubemap, Texture2DArray, CubemapArray or Texture3D)
 * @returns the decoded texture
 * @throws {FormatError} if the object isn't a texture or doesn't decode
 */
export const loadTexture = async (resolver: AssetResolver, ref: ObjectRef): Promise<DecodedTexture> => {
	if (!isTextureClass(ref.info.classId)) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a texture`);
	}
	const texture = await resolver.read(ref);
	const stream = streamingInfo(texture);
	return decodeTexture(ref.info.classId, texture, stream && (await resolver.streamData(ref, stream)));
};

const shaderCache = new WeakMap<AssetResolver, Map<string, Promise<ShaderSummary>>>();

/**
 * reads a shader's name and tags; only `m_ParsedForm` is materialized, and results are cached per resolver
 *
 * @param resolver asset resolver
 * @param ref a Shader object
 * @returns its summary
 */
export const loadShaderSummary = (resolver: AssetResolver, ref: ObjectRef): Promise<ShaderSummary> => {
	const cache = shaderCache.getOrInsertComputed(resolver, () => new Map());
	return cache.getOrInsertComputed(objectKey(ref), async () => {
		if (ref.info.classId !== UnityClass.Shader) {
			throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Shader`);
		}
		const parsed = await ref.file.readField(ref.info, 'm_ParsedForm');
		if (!isObject(parsed)) {
			throw new FormatError(`shader ${ref.info.pathId} has no m_ParsedForm`);
		}
		return summarizeShader(parsed);
	});
};
