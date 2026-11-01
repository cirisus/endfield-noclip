import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { Context } from '../context.ts';

import type { AssetResolver, ObjectRef } from './assets.ts';

const QUAD_PATH = 'Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/Quad.fbx';

/**
 * @param context the install's world index
 * @param resolver asset resolver
 * @returns the render pipeline's unit quad, or null if it cannot be resolved
 */
export const findParticleQuad = async (
	context: Pick<Context, 'world'>,
	resolver: AssetResolver,
): Promise<ObjectRef | null> => {
	const [hash] = await context.world.hashesOf(QUAD_PATH);
	if (hash === undefined) {
		return null;
	}
	try {
		return await resolver.findUnique({ hash, path: QUAD_PATH }, UnityClass.Mesh);
	} catch {
		return null;
	}
};
