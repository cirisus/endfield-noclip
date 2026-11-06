import { type CelestialLook, celestialTextures } from '../environment/celestial-look.ts';
import type { Environment } from '../environment/environment.ts';
import type { FrameBindings, FrameTextureSlot } from '../render/frame/frame-bindings.ts';
import type { PostProcess } from '../render/post/post-process.ts';
import type { TextureStore } from '../render/textures/texture-store.ts';
import {
	type StreamedTexture,
	type TextureKind,
	type TextureStream,
	streamWholeTexture,
} from '../streaming/texture-requests.ts';

/** the sky's textures are wanted above all scenery */
const SKY_PRIORITY = 1e6;

/** a frame group texture, and where the environment names it */
interface FrameTexture {
	slot: FrameTextureSlot;
	id: (environment: Environment) => number | null;
}

/** the frame group's 2D textures */
const FRAME_TEXTURES: readonly FrameTexture[] = [
	{ slot: 'shadowRamp', id: (environment) => environment.shadow.ramp },
	{ slot: 'cloudShadow', id: (environment) => environment.cloudShadow?.texture ?? null },
];

/**
 * streams the environment's sky textures whole (cloud panorama, flow noise, celestial layers, lens flare
 * images, reflection cubemap, shadow ramp, cloud shadow) and binds them as they arrive. call once per
 * traversal.
 *
 * @param source the loaded package's stream and texture store, and its flow noise texture
 * @param look the environment shown, its celestial layers, and whether drifting fog is on
 * @param targets where the textures bind
 */
export const updateSkyTextures = (
	source: { stream: TextureStream; textures: TextureStore; flowNoise: number | null },
	look: { environment: Environment; celestial: CelestialLook; flowNoise: boolean },
	targets: { post: PostProcess; bindings: FrameBindings },
): void => {
	const { stream, textures } = source;
	const { environment } = look;
	const whole = (id: number | null, kind: TextureKind): StreamedTexture | null =>
		streamWholeTexture({ stream, textures, id, kind, priority: SKY_PRIORITY });

	const cloud = whole(environment.cloud?.texture ?? null, '2d');
	// the flow noise is one texture for the whole package, wanted only while an environment drifts
	const flowNoise =
		environment.heightFog.flowNoise === null || !look.flowNoise ? null : whole(source.flowNoise, '3d');
	const celestialIds = celestialTextures(look.celestial);
	targets.post.setSkyTextures({
		cloud: cloud?.binding ?? null,
		flowNoise: flowNoise?.binding ?? null,
		celestial: (slot) => whole(celestialIds[slot], '2d')?.binding ?? null,
		lensFlare: (id) => whole(id, '2d'),
	});

	const reflection = whole(environment.reflection, 'cube');
	targets.bindings.setReflection(reflection?.binding ?? null, reflection?.entry.mipCount ?? 1);
	for (const { slot, id } of FRAME_TEXTURES) {
		targets.bindings.set(slot, whole(id(environment), '2d')?.binding?.view ?? null);
	}
};
