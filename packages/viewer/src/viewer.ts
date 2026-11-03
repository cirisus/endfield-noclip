import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	conditionResults,
	groupsShown,
	resolveSceneValues,
} from '@endfield-noclip/package-format/conditions';
import type { LevelEnvironment, LevelInfo } from '@endfield-noclip/package-format/manifest';
import type { PointView } from '@endfield-noclip/package-format/oem';
import type { MissionInfo, SceneControl, StatesInfo } from '@endfield-noclip/package-format/states';
import type { PhotoFilter } from '@endfield-noclip/package-format/photo-filters';
import { proximityValues } from '@endfield-noclip/package-format/proximity';
import {
	areasShownIn,
	streamAreaValues,
	zonesAround,
	zonesAt,
} from '@endfield-noclip/package-format/stream-areas';
import {
	isTerrainHole,
	TERRAIN_HOLE_BIT,
	TERRAIN_PAGE_SAMPLES,
	terrainHeight,
} from '@endfield-noclip/package-format/terrain';
import { tileAt, tileId } from '@endfield-noclip/package-format/tiles';
import type { ContentRef } from '@endfield-noclip/package-format/tree';

import { mapDefined } from '@mary-ext/array-fns';

import { type BindLayouts, createBindLayouts } from './gfx/bind-layouts.ts';
import { type GfxDevice, createGfxDevice } from './gfx/device.ts';
import { GpuProfiler } from './gfx/gpu-profiler.ts';
import { PipelineCache } from './gfx/pipeline-cache.ts';
import { RenderTargets } from './gfx/render-targets.ts';
import { UniformRing } from './gfx/uniform-ring.ts';
import { DecodePool } from './package/decode-pool.ts';
import type { PackageSource } from './package/package-source.ts';
import { CORE_ARCHIVE_INDEX, type ViewerPackage, openViewerPackage } from './package/viewer-package.ts';
import { type CelestialLook, NO_CELESTIAL, celestialLook, celestialTextures } from './render/celestial.ts';
import {
	type AppliedVolume,
	blendEnvironment,
	EnvironmentFades,
	eyeInLevelVolume,
	volumeLevelTag,
} from './render/environment-blend.ts';
import { type Environment, deriveEnvironment, windClockRate } from './render/environment.ts';
import { DEBUG_VIEWS, type DebugView, FRAME_UNIFORM_BYTES, FrameOffsets } from './render/frame-uniforms.ts';
import { InstanceRenderer } from './render/instance-renderer.ts';
import {
	markBillboardRows,
	ROW_BYTES,
	ROW_WORDS,
	RowKind,
	type RowKinds,
	type TierSpan,
	turnRows,
} from './render/instance-rows.ts';
import { IrradianceVolume } from './render/irradiance-volume.ts';
import { lensFlareLook } from './render/lens-flare-layout.ts';
import { LocalLights } from './render/local-lights.ts';
import { materialLooks } from './render/materials.ts';
import { MeshRenderer } from './render/mesh-renderer.ts';
import { ParticleField } from './render/particles.ts';
import { type PostSettings, PostProcess, type Tonemapper, postExposure } from './render/post-process.ts';
import { SHADOW_FORMAT, SHADOW_LAYERS, ShadowMap, offscreenCasters } from './render/shadow-map.ts';
import { SETTLE_FRAMES } from './render/temporal-aa.ts';
import { TerrainRenderer } from './render/terrain-renderer.ts';
import { type TextureBinding, TextureStore, placeholderView } from './render/texture-store.ts';
import { VolumetricFog } from './render/volumetric-fog.ts';
import { WaterLevels, type WaterVolumeState } from './render/water-levels.ts';
import { WaterRenderer } from './render/water-renderer.ts';
import { wetnessParams } from './render/wetness.ts';
import { Camera, type Vec3 } from './scene/camera.ts';
import { type CameraPose, NoclipControls } from './scene/noclip-controls.ts';
import { pointPreview } from './scene/point-preview.ts';
import { pointViewKey, readPointView, writePointView } from './scene/point-view-cache.ts';
import { type TileTree, buildTileTree } from './scene/tile-tree.ts';
import { type MeshSelection, MeshSelector, streamWholeTexture } from './streaming/mesh-selection.ts';
import { type InstanceRange, Selector } from './streaming/selection.ts';
import { type ResidentInstances, StreamManager } from './streaming/stream-manager.ts';

// #region options and stats

/** user-facing switches */
export interface ViewerOptions {
	/** exported photo filter id, or null for the scene's own look */
	photoFilter: string | null;
	/** multiplier of the authored external LUT contribution, 0–1 */
	photoLutStrength: number;
	terrain: boolean;
	/** draw the terrain's baked albedo and normal pages; off (or without BC textures) shows stand-in colours */
	terrainSurface: boolean;
	/** blend the terrain's close-up material layers near the camera (needs BC textures) */
	terrainSplat: boolean;
	instances: boolean;
	detail: boolean;
	global: boolean;
	/**
	 * show the stream areas the game shows at the camera, as its trigger zones decide; off shows every area of
	 * the level at once
	 */
	streamAreas: boolean;
	/** enabled HLOD tiers 0–2 */
	hlodTiers: [boolean, boolean, boolean];
	wireframe: boolean;
	/** draw stand-in boxes for instances with no resident mesh LOD, or every instance without geometry */
	boxes: boolean;
	/** draw meshes whose material the viewer lacks in the unsupported checker; off skips them */
	unsupportedMaterials: boolean;
	/**
	 * draw the package's stand-ins (`DrawRole.Unsupported`) for content the viewer doesn't draw at all, in the
	 * unsupported checker; off skips them
	 */
	missingContent: boolean;
	/** instance refinement threshold, px */
	maxSse: number;
	/** terrain sample spacing target, px */
	terrainPixels: number;
	/** boxes smaller than this on screen are culled, px */
	minBoxPixels: number;
	/** boxes with a half extent above this draw as outlines only, m */
	outlineMetres: number;
	/** streamed content budget, MiB */
	budgetMiB: number;
	/** stream material textures this many mip levels coarser than the view needs (each quarters their memory) */
	textureBias: number;
	/** render every frame instead of only on change (for measuring) */
	continuous: boolean;
	/** temporal antialiasing; off shows each frame as rendered */
	antialiasing: boolean;
	/** the render size relative to the canvas, (0, 1]; temporal antialiasing upsamples to the canvas */
	renderScale: number;
	/** exposure compensation on top of the level's exposure, EV */
	exposure: number;
	/** enable photographic foreground and background defocus */
	depthOfField: boolean;
	/** photographic f-number */
	aperture: number;
	/** focus plane distance along the camera forward axis, metres */
	focusDistance: number;
	/** adapt the exposure to the view as the game's auto exposure does */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	heightFog: boolean;
	atmosphereFog: boolean;
	shadows: boolean;
	/** darken the sun under the environment's projected cloud shadow texture */
	cloudShadows: boolean;
	/** sway how much fog surfaces get with the environment's drifting 3D noise, where it has one */
	flowNoise: boolean;
	/** play animation (effects, particles, water, clouds, flow noise) on rendered frames; disabling freezes it */
	animate: boolean;
	water: boolean;
	/**
	 * how many times faster than the game water volumes move to the level their `waterLevel` control picks;
	 * `Infinity` jumps
	 */
	waterLevelRate: number;
	ao: boolean;
	/** screen-space reflections, as on puddles, wet floors and metal */
	reflections: boolean;
	bloom: boolean;
	vignette: boolean;
	/** light ambient from the baked irradiance volume; off uses the environment's ambient probe alone */
	irradiance: boolean;
	/** light surfaces and the volumetric fog with the package's point and spot lights */
	localLights: boolean;
	/** blend the game's environment volumes at the camera; off shows the level's base environment */
	environmentVolumes: boolean;
	/** an environment phase to show over the base instead of the volumes, or `null` */
	environmentPin: number | null;
	/** a material channel instead of the lit image */
	debugView: DebugView;
}

/** defaults for {@link ViewerOptions} */
export const DEFAULT_OPTIONS: ViewerOptions = {
	photoFilter: null,
	photoLutStrength: 1,
	terrain: true,
	terrainSurface: true,
	terrainSplat: true,
	instances: true,
	detail: true,
	global: true,
	streamAreas: true,
	hlodTiers: [true, true, true],
	wireframe: false,
	boxes: true,
	unsupportedMaterials: false,
	missingContent: false,
	maxSse: 12,
	terrainPixels: 3,
	minBoxPixels: 1.5,
	outlineMetres: 60,
	// the densest views (Wuling City at street level) want ~550–700 MiB of content
	budgetMiB: 768,
	textureBias: 0,
	continuous: false,
	antialiasing: true,
	renderScale: 1,
	exposure: 0,
	depthOfField: false,
	aperture: 32,
	focusDistance: 10,
	autoExposure: true,
	tonemapper: 'game',
	sky: true,
	heightFog: true,
	atmosphereFog: true,
	shadows: true,
	cloudShadows: true,
	flowNoise: true,
	animate: true,
	water: true,
	waterLevelRate: 1,
	ao: true,
	reflections: true,
	bloom: true,
	vignette: true,
	irradiance: true,
	localLights: true,
	environmentVolumes: true,
	environmentPin: null,
	debugView: 'lit',
};

/** numbers for the stats panel */
export interface ViewerStats {
	adapter: string;
	features: string[];
	/** smoothed time between rendered frames, ms */
	frameMs: number;
	/** smoothed CPU time per frame that did work (traversal, streaming, encoding), ms */
	cpuMs: number;
	/** {@link cpuMs} by frame phase, ms */
	cpuPhases: Record<string, number>;
	/** smoothed GPU time of all passes, ms, if timestamps are available */
	gpuMs: number | null;
	/** GPU time by pass label, ms; see {@link GpuProfiler.passes} for how far to trust it */
	gpuPasses: Record<string, number>;
	/** the auto exposure's adjustment, EV (0 when off) */
	autoExposureEv: number;
	draws: number;
	triangles: number;
	instances: number;
	/** instances drawn as meshes (the rest are boxes) */
	meshInstances: number;
	/** mesh draws with their base colour texture bound */
	texturedDraws: number;
	/** GPU bytes of integrated texture levels */
	textureBytes: number;
	terrainPatches: number;
	nodesVisited: number;
	residentBytes: number;
	pinnedBytes: number;
	poolBytes: number;
	queued: number;
	requestsInFlight: number;
	decoding: number;
	uploading: number;
	downloadedBytes: number;
	requests: number;
	evictions: number;
	failed: number;
	/** the package was re-packed since it was opened; streaming has stopped until a reload */
	packageChanged: boolean;
	geometriesReady: number;
	geometriesTotal: number;
	camera: { position: Vec3; yaw: number; pitch: number; speed: number };
}

/** what the level list needs */
export interface LevelEntry {
	id: string;
	name: string;
	instances: number;
}

// #endregion

const TERRAIN_SLOTS = 4096;
const INSTANCE_ROWS = 1_500_000;
const STATS_INTERVAL = 250;
/** the irradiance volume of a package without one */
const EMPTY_IRRADIANCE = { keys: new Uint32Array(), blobs: new Uint32Array(), groups: new Uint32Array() };
/** how far over the terrain a level's first view stays (m) */
const VIEW_CLEARANCE = 100;
/** headings a level's first view tries, from the south round */
const VIEW_HEADINGS = 8;

interface LoadedScene {
	pkg: ViewerPackage;
	tree: TileTree;
	stream: StreamManager;
	selector: Selector;
	/** per-instance LOD selection, when the package has converted geometry */
	meshes: MeshSelector | null;
	textures: TextureStore;
	levels: LevelEntry[];
}

/**
 * @param tree the linked tree
 * @param global manifest.global refs
 * @returns what the rows of each instance blob are: rows of HLOD blocks take their tier from the refs that
 *   slice them
 */
const instanceRowKinds = (tree: TileTree, global: readonly ContentRef[]): Map<number, RowKinds> => {
	const kinds = new Map<number, RowKinds>();
	const spans = new Map<number, TierSpan[]>();
	for (const node of tree.nodes) {
		for (const ref of node.hlod) {
			const list = spans.getOrInsertComputed(ref.blob, () => {
				const created: TierSpan[] = [];
				kinds.set(ref.blob, created);
				return created;
			});
			list.push({ first: ref.first, count: ref.count, tier: ref.tier });
		}
		for (const ref of [...node.detail, ...node.conditional]) {
			kinds.set(ref.blob, RowKind.Detail);
		}
	}
	for (const ref of global) {
		kinds.set(ref.blob, RowKind.Global);
	}
	return kinds;
};

/** transient GPU targets for a host overlay, after tonemapping */
export interface OverlayFrame {
	device: GPUDevice;
	encoder: GPUCommandEncoder;
	target: GPUTextureView;
	format: GPUTextureFormat;
	/** current opaque/cutout scene depth, reversed-Z; 0 is empty */
	depth: GPUTextureView;
	width: number;
	height: number;
	/** current depth-buffer projection jitter in NDC */
	jitter: readonly [number, number];
}

/** the running viewer */
export class Viewer {
	#overlays = new Set<(frame: OverlayFrame) => void>();

	/**
	 * @param encode uses this frame's targets; refresh depth bindings when the view changes
	 * @returns unregisters the overlay and invalidates the displayed frame; the host owns its GPU resources
	 */
	addOverlay(encode: (frame: OverlayFrame) => void): () => void {
		this.#overlays.add(encode);
		this.#dirty = true;
		return () => {
			this.#overlays.delete(encode);
			this.#dirty = true;
		};
	}
	readonly camera = new Camera();
	#baseStates: StatesInfo | null = null;
	#cameraListeners = new Set<() => void>();

	/** @param listener called after camera changes @returns unsubscribe */
	subscribeCamera(listener: () => void): () => void {
		this.#cameraListeners.add(listener);
		return () => this.#cameraListeners.delete(listener);
	}

	/**
	 * replaces OEM-only controls for the current point, retaining the original package's conditions.
	 *
	 * @param controls additional quest and mission states
	 * @param missions their story labels
	 */
	setCompanion(controls: readonly SceneControl[], missions: readonly MissionInfo[]): void {
		const pkg = this.scene?.pkg,
			base = this.#baseStates;
		if (!pkg || !base) {
			return;
		}
		const byId = new Map(base.controls.map((c) => [c.id, c]));
		for (const c of controls) {
			if (!byId.has(c.id) && (c.kind === 'quest' || c.kind === 'mission') && c.derived === null) {
				byId.set(c.id, c);
			}
		}
		pkg.manifest.states = {
			...base,
			controls: [...byId.values()],
			missions: [...new Map([...base.missions, ...missions].map((m) => [m.id, m])).values()],
		};
		this.#scenePicks = {};
		this.#updateVisibility();
		this.#emitState();
	}
	readonly controls: NoclipControls;
	readonly options: ViewerOptions = structuredClone(DEFAULT_OPTIONS);
	stats: ViewerStats;
	/** bumped when the package, the options or the shown level change; a cheap snapshot for the UI */
	stateRevision = 0;
	/** bumped when {@link stats} change */
	statsRevision = 0;
	scene: LoadedScene | null = null;

	#gfx: GfxDevice;
	#targets: RenderTargets;
	#layouts: BindLayouts;
	#pipelines: PipelineCache;
	#ring: UniformRing;
	#frameBindGroup: GPUBindGroup;
	#shadowFrameBindGroup: GPUBindGroup;
	#shadows: ShadowMap;
	#shadowPlaceholder: GPUTextureView;
	/** bound while the level has no reflection cubemap, or it hasn't streamed in */
	#noReflection: TextureBinding;
	/** the reflection binding the frame groups were built with */
	#reflection: TextureBinding;
	/** mip levels of the bound reflection cubemap, minus one */
	#reflectionMips = 0;
	/** black: bound while the environment has no shadow ramp, or it hasn't streamed in */
	#noShadowRamp: GPUTextureView;
	/** the shadow ramp view the frame groups were built with */
	#shadowRamp: GPUTextureView;
	/** bound while the environment has no cloud shadow, or it hasn't streamed in */
	#noCloudShadow: GPUTextureView;
	/** the cloud shadow view the frame groups were built with */
	#cloudShadow: GPUTextureView;
	readonly #lights: LocalLights;
	#profiler: GpuProfiler;
	#terrain: TerrainRenderer;
	#instances: InstanceRenderer;
	#meshes: MeshRenderer;
	#post: PostProcess;
	#fog: VolumetricFog;
	/** the loaded package's irradiance volume; an empty one without a package */
	#irradiance: IrradianceVolume;
	#water: WaterRenderer;
	#waterLevels = new WaterLevels();
	/** the shown level's look */
	#environment: Environment = deriveEnvironment(null);
	/** the nebula and planets of {@link #environment}'s profile */
	#celestial: CelestialLook = NO_CELESTIAL;
	/** `Frame.wetness` for {@link #environment}'s profile */
	#wetness: Float32Array = wetnessParams(undefined);
	/** the shown level's base environment, which the volumes blend over */
	#baseEnvironment: LevelEnvironment | null = null;
	#photoFilters: readonly PhotoFilter[] = [];
	/** what the environment was last blended for */
	#blendEye: Vec3 = [Infinity, Infinity, Infinity];
	#blendSettings = '';
	#blendKey: string | null = null;
	#appliedVolumes: AppliedVolume[] = [];
	/** the time-faded volumes' fade state for the camera */
	readonly #fades = new EnvironmentFades();
	#pool: DecodePool;
	#listeners = new Set<() => void>();
	#raf = 0;
	#frame = 0;
	#lastTime = 0;
	#lastStats = 0;
	#statsKey = '';
	#dirty = true;
	/**
	 * redraws when the page is shown again: Firefox re-shows a hidden tab's last frame with red and blue
	 * swapped, and an idle view would otherwise never present a new one
	 */
	readonly #onVisibilityChange = (): void => {
		if (document.visibilityState === 'visible') {
			this.#dirty = true;
		}
	};
	/** the stream version the last traversal saw */
	#seenVersion = -1;
	/** compiled pipelines when the last frame began */
	#seenPipelines = 0;
	#frameMs = 16.7;
	#cpuMs = 0;
	/** CPU time per frame phase in this frame so far, ms */
	#frameSpans = new Map<string, number>();
	/** {@link #frameSpans} smoothed over the frames that did work */
	#cpuSpans = new Map<string, number>();
	/** when the current span started */
	#spanAt = 0;
	#visited = 0;
	#focusCells: Set<string> | null = null;
	/** the level being shown; `null` when the package has no level with content, which shows everything */
	#level: LevelInfo | null = null;
	/**
	 * the first view after loading, when it was posed before the coarse terrain was resident (at the spawn
	 * height); it's re-posed over the ground once that lands, unless the camera moved first
	 */
	#unsettledPose: CameraPose | null = null;
	#lastDraws = 0;
	#viewProj = new Float32Array(16);
	/** frames still to render so the temporal antialiasing settles after the view stopped changing */
	#settleFrames = 0;
	/** whether the last mesh selection drew particles, which frames of a still view re-evaluate */
	#particlesShown = false;
	/** whether the last selection held spinning rows, which turn by the clock while the view holds still */
	#spinsShown = false;
	/** the clock each resident block's spinning rows were last turned to */
	#spinTimes = new WeakMap<ResidentInstances, number>();
	/** whether the shadow layers need drawing: the casters changed, or they weren't drawn last frame */
	#shadowsStale = true;
	/** each shadow layer's render matrix when it was last drawn */
	#shadowFits = new Float32Array(16 * SHADOW_LAYERS);
	/**
	 * the animation time everything that moves by the clock reads, s. it advances only on rendered frames while
	 * `animate` is on, so animation pauses when the view idles and resumes where it stopped
	 */
	#time = 0;
	/** the wind clock (`Frame.wind.x`), which advances with {@link #time} at the wind's rate */
	#windClock = 0;

	private constructor(gfx: GfxDevice, canvas: HTMLCanvasElement) {
		this.#gfx = gfx;
		const device = gfx.device;
		this.#targets = new RenderTargets(
			device,
			canvas,
			gfx.presentationFormat,
			gfx.features.depth32floatStencil8,
		);
		this.#layouts = createBindLayouts(device);
		this.#pipelines = new PipelineCache(device);
		// the main pass's frame plus one per shadow layer
		const alignment = device.limits.minUniformBufferOffsetAlignment;
		this.#ring = new UniformRing(
			device,
			Math.ceil(FRAME_UNIFORM_BYTES / alignment) * alignment * (1 + SHADOW_LAYERS),
			3,
		);
		this.#shadows = new ShadowMap(device);
		// the shadow passes can't bind the map they render into
		this.#shadowPlaceholder = placeholderView(device, {
			label: 'shadow placeholder',
			dimension: '2d-array',
			format: SHADOW_FORMAT,
		});
		this.#noReflection = {
			view: placeholderView(device, { label: 'no reflection', dimension: 'cube' }),
			sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
			version: -1,
		};
		this.#reflection = this.#noReflection;
		this.#noShadowRamp = placeholderView(device, { label: 'no shadow ramp', dimension: '2d' });
		this.#shadowRamp = this.#noShadowRamp;
		this.#noCloudShadow = placeholderView(device, { label: 'no cloud shadow', dimension: '2d' });
		this.#cloudShadow = this.#noCloudShadow;
		this.#irradiance = new IrradianceVolume(device, EMPTY_IRRADIANCE, []);
		this.#lights = new LocalLights(device);
		[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		this.#profiler = new GpuProfiler(device, gfx.features.timestampQuery);
		const format = this.#targets.format;
		this.#terrain = new TerrainRenderer(device, this.#layouts, this.#pipelines, format, {
			capacity: TERRAIN_SLOTS,
			bc: gfx.features.textureCompressionBc,
		});
		this.#instances = new InstanceRenderer(device, this.#layouts, this.#pipelines, format, INSTANCE_ROWS);
		this.#meshes = new MeshRenderer(device, this.#layouts, this.#pipelines, this.#instances, format);
		this.#fog = new VolumetricFog(device, this.#layouts.frame);
		this.#fog.setEnvironment(this.#environment, this.camera.near);
		this.#post = new PostProcess(device, gfx.presentationFormat, this.#environment, this.#fog);
		this.#water = new WaterRenderer(device, { frame: this.#layouts.frame, ...this.#post.skyLayouts });
		this.#pool = new DecodePool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)));
		this.controls = new NoclipControls(this.camera, canvas);
		this.stats = this.#emptyStats();
	}

	/**
	 * @param canvas the canvas to render into
	 * @param onLost called if the GPU device is lost
	 * @param signal abandons the creation; once aborted, the canvas is left untouched
	 * @returns a running viewer
	 * @throws {GfxUnsupportedError} without WebGPU
	 * @throws the signal's reason when aborted
	 */
	static async create(
		canvas: HTMLCanvasElement,
		onLost: (reason: string) => void,
		signal: AbortSignal,
	): Promise<Viewer> {
		const gfx = await createGfxDevice(onLost);
		// a canvas has one WebGPU context, shared by every viewer made on it. an abandoned viewer built anyway
		// would reconfigure that context and then unconfigure it on destroy, blacking out the viewer that
		// replaced it, so drop the device before touching the canvas
		if (signal.aborted) {
			gfx.device.destroy();
			throw signal.reason;
		}
		const viewer = new Viewer(gfx, canvas);
		viewer.#raf = requestAnimationFrame((time) => viewer.#tick(time));
		document.addEventListener('visibilitychange', viewer.#onVisibilityChange);
		return viewer;
	}

	// #region package

	/**
	 * opens a package and starts streaming it, replacing any loaded one.
	 *
	 * @param source where the package lives
	 * @param initialLevel id of the level to show first; when absent from the package, the first level with
	 *   content is shown
	 * @param onProgress loading phases for the UI
	 * @param loadOptions preserveCamera keeps the live camera and streams around it instead of an overview
	 */
	async load(
		source: PackageSource,
		initialLevel: string | null,
		onProgress: (phase: string) => void,
		loadOptions: { preserveCamera?: boolean } = {},
	): Promise<void> {
		this.unload();
		const pkg = await openViewerPackage(source, onProgress);
		this.#baseStates = pkg.manifest.states;
		const tree = buildTileTree(pkg.manifest, pkg.tree);

		const textures = new TextureStore(this.#gfx.device, pkg.textures, {
			bc: this.#gfx.features.textureCompressionBc,
		});
		const irradiance = new IrradianceVolume(this.#gfx.device, pkg.irradiance, pkg.manifest.irradianceRegions);
		this.#setIrradiance(irradiance);
		const particles = new ParticleField(pkg.particles, this.#instances);
		const stream = new StreamManager(
			pkg,
			this.#pool,
			{
				uploadHeights: (decoded, options) => this.#terrain.upload(decoded, options),
				uploadSurface: (decoded) => this.#terrain.uploadSurface(decoded),
				uploadDetail: (decoded) => this.#terrain.uploadDetail(decoded),
				uploadLayer: (blob, decoded) => this.#terrain.uploadLayer(blob, decoded),
				uploadInstances: (blob, decoded) => {
					// the decode worker doesn't hold the chains
					markBillboardRows(decoded, pkg.chains);
					const resident = this.#instances.upload(decoded);
					if (resident !== null) {
						this.#waterLevels.track(resident, blob);
					}
					return resident;
				},
				uploadGeometry: (blob, decoded) => this.#meshes.upload(blob, decoded),
				uploadTexture: (blob, decoded) => textures.upload(blob, decoded),
				uploadIrradiance: (_blob, decoded) => irradiance.upload(decoded),
				release: (blob, resident) => {
					switch (resident.kind) {
						case 'heights': {
							this.#terrain.release(resident);
							break;
						}
						case 'surface': {
							this.#terrain.releaseSurface(resident);
							break;
						}
						case 'splat': {
							this.#terrain.releaseSplat(resident);
							break;
						}
						case 'layer': {
							// pinned for the package's lifetime; its array goes with the next `setSplat`
							break;
						}
						case 'instances': {
							particles.release(resident);
							this.#waterLevels.untrack(resident);
							this.#instances.release(resident);
							break;
						}
						case 'geometry': {
							this.#meshes.release(resident);
							break;
						}
						case 'texture': {
							textures.release(blob);
							break;
						}
						case 'irradiance': {
							irradiance.release(resident);
							break;
						}
					}
				},
			},
			instanceRowKinds(tree, pkg.manifest.global),
			{ budgetBytes: this.options.budgetMiB * 2 ** 20, maxRequests: 32, uploadBytesPerFrame: 24 * 2 ** 20 },
		);
		// the coarse layer: everything in the core (coarse terrain pages, every HLOD block, global scenery)
		const coreBlobs: number[] = [];
		for (let i = 0; i < pkg.blobs.length; i++) {
			const blob = pkg.blobs[i];
			if (blob.archive !== CORE_ARCHIVE_INDEX) {
				continue;
			}
			switch (blob.kind) {
				case BlobKind.TerrainHeights:
				case BlobKind.Instances: {
					coreBlobs.push(i);
					break;
				}
				case BlobKind.TerrainSurface: {
					if (this.#terrain.surfaces) {
						coreBlobs.push(i);
					}
					break;
				}
			}
		}
		// every splat page draws from all layer textures, so they stay resident
		const splat = pkg.manifest.terrain?.splat ?? null;
		this.#terrain.setSplat(splat);
		if (splat !== null && this.#terrain.surfaces) {
			coreBlobs.push(...new Set([...splat.diffuse, ...splat.normal]));
		}
		stream.pin(coreBlobs);

		const manifest = pkg.manifest;
		const selector = new Selector(tree, stream, manifest.global, manifest.tree.rootSize);
		const geometries = pkg.geometries.entries;
		const geometriesReady = geometries.reduce((sum, entry) => sum + (entry.status === 'ready' ? 1 : 0), 0);
		this.scene = {
			pkg,
			tree,
			stream,
			selector,
			meshes:
				geometriesReady > 0
					? new MeshSelector({
							chains: pkg.chains,
							geometries,
							looks: materialLooks(pkg.materials),
							stream,
							textures,
							particles,
						})
					: null,
			textures,
			levels: manifest.levels.map((level) => ({
				id: level.id,
				name: level.name ?? level.id,
				instances: level.instances,
			})),
		};
		this.#scenePicks = {};
		const showable = manifest.levels.filter((level) => level.instances > 0);
		this.#level = showable.find((level) => level.id === initialLevel) ?? showable[0] ?? null;
		this.#post.autoExposure.reset();
		this.#water.setTable(pkg.water);
		this.#waterLevels.setVolumes(pkg.water.volumes);
		this.#lights.setLights(pkg.lights.lights);
		this.#updateVisibility();
		this.#applyEnvironment();
		if (this.#level !== null && !loadOptions.preserveCamera) {
			this.#focusCells = this.#cellIds(this.#level);
		}
		if (loadOptions.preserveCamera) {
			this.#unsettledPose = null;
		} else if (this.#level === null) {
			const pose = this.#overviewPose();
			if (pose !== null) {
				this.#setPose(pose);
			}
		} else {
			const { pose, settled } = this.#levelPose(this.#level);
			this.#setPose(pose);
			this.#unsettledPose = settled ? null : pose;
		}
		this.stats.geometriesTotal = geometries.length;
		this.stats.geometriesReady = geometriesReady;
		this.#dirty = true;
		this.#emitState();
		onProgress('streaming');
	}

	/** drops the loaded package and its GPU content */
	unload(): void {
		this.scene?.stream.destroy();
		this.scene?.textures.destroy();
		this.#meshes.releaseMaterials();
		// the destroyed store's sky textures
		this.#post.setCloud(null);
		this.#post.setFlowNoise(null);
		this.#post.celestial.setTextures(() => null);
		this.#post.lensFlares.setTextures(() => null);
		this.#setReflection(this.#noReflection, 1);
		this.#setShadowRamp(null);
		this.scene = null;
		this.#baseStates = null;
		this.#scenePicks = {};
		this.#sceneValues = {};
		this.options.environmentPin = null;
		this.#fades.reset();
		this.#setIrradiance(new IrradianceVolume(this.#gfx.device, EMPTY_IRRADIANCE, []));
		this.#water.setTable(null);
		this.#waterLevels.setVolumes([]);
		this.#lights.setLights([]);
		this.#terrain.setSplat(null);
		this.#level = null;
		this.#unsettledPose = null;
		this.#focusCells = null;
		this.#applyEnvironment();
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns group 0 for the main pass and for the shadow passes, with the bound sky and shadow textures */
	#frameGroups(): [main: GPUBindGroup, shadow: GPUBindGroup] {
		const device = this.#gfx.device;
		const reflection = this.#reflection;
		const group = (label: string, shadowView: GPUTextureView): GPUBindGroup =>
			device.createBindGroup({
				label,
				layout: this.#layouts.frame,
				entries: [
					{ binding: 0, resource: { buffer: this.#ring.buffer, size: FRAME_UNIFORM_BYTES } },
					{ binding: 1, resource: shadowView },
					{ binding: 2, resource: this.#shadows.sampler },
					{ binding: 3, resource: reflection.view },
					{ binding: 4, resource: reflection.sampler },
					...irradiance.flatMap(({ a, b }, level) => [
						{ binding: 5 + level * 2, resource: a },
						{ binding: 6 + level * 2, resource: b },
					]),
					{ binding: 11, resource: this.#irradiance.sampler },
					{ binding: 12, resource: this.#irradiance.clampSampler },
					{ binding: 13, resource: this.#shadows.gatherSampler },
					{ binding: 14, resource: this.#shadowRamp },
					{ binding: 15, resource: { buffer: this.#lights.lightBuffer } },
					{ binding: 16, resource: { buffer: this.#lights.binBuffer } },
					{ binding: 17, resource: this.#cloudShadow },
				],
			});
		const irradiance = this.#irradiance.views();
		return [group('frame', this.#shadows.view), group('shadow frame', this.#shadowPlaceholder)];
	}

	/** swaps in a package's irradiance volume and rebinds the frame groups */
	#setIrradiance(irradiance: IrradianceVolume): void {
		this.#irradiance.destroy();
		this.#irradiance = irradiance;
		[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
	}

	/** streams the level's sky textures (reflection cubemap, cloud panorama) and binds them as they arrive */
	#updateSkyTextures(scene: LoadedScene): void {
		const { stream, textures } = scene;
		const environment = this.#environment;
		const cloud = streamWholeTexture({
			stream,
			textures,
			id: environment.cloud?.texture ?? null,
			kind: '2d',
			priority: 1e6,
		});
		this.#post.setCloud(cloud?.binding ?? null);
		// the flow noise is one texture for the whole package, wanted only while an environment drifts
		const flowNoise =
			environment.heightFog.flowNoise === null || !this.options.flowNoise
				? null
				: streamWholeTexture({
						stream,
						textures,
						id: scene.pkg.manifest.heightFogFlowNoise ?? null,
						kind: '3d',
						priority: 1e6,
					});
		this.#post.setFlowNoise(flowNoise?.binding ?? null);

		const celestialIds = celestialTextures(this.#celestial);
		this.#post.celestial.setTextures(
			(slot) =>
				streamWholeTexture({ stream, textures, id: celestialIds[slot], kind: '2d', priority: 1e6 })
					?.binding ?? null,
		);
		this.#post.lensFlares.setTextures((id) =>
			streamWholeTexture({ stream, textures, id, kind: '2d', priority: 1e6 }),
		);

		const reflection = streamWholeTexture({
			stream,
			textures,
			id: environment.reflection,
			kind: 'cube',
			priority: 1e6,
		});
		this.#setReflection(reflection?.binding ?? this.#noReflection, reflection?.entry.mipCount ?? 1);

		const ramp = streamWholeTexture({
			stream,
			textures,
			id: environment.shadow.ramp,
			kind: '2d',
			priority: 1e6,
		});
		this.#setShadowRamp(ramp?.binding?.view ?? null);

		const cloudShadow = streamWholeTexture({
			stream,
			textures,
			id: environment.cloudShadow?.texture ?? null,
			kind: '2d',
			priority: 1e6,
		});
		this.#setCloudShadow(cloudShadow?.binding?.view ?? null);
	}

	/** rebinds the frame groups when the cloud shadow's view changed; `null` binds the placeholder */
	#setCloudShadow(view: GPUTextureView | null): void {
		const next = view ?? this.#noCloudShadow;
		if (next !== this.#cloudShadow) {
			this.#cloudShadow = next;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** rebinds the frame groups when the shadow ramp's view changed; `null` binds the black placeholder */
	#setShadowRamp(view: GPUTextureView | null): void {
		const next = view ?? this.#noShadowRamp;
		if (next !== this.#shadowRamp) {
			this.#shadowRamp = next;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** rebinds the frame groups when the reflection's binding changed (the store hands out a new one then) */
	#setReflection(binding: TextureBinding, mipCount: number): void {
		if (binding !== this.#reflection) {
			this.#reflection = binding;
			this.#reflectionMips = mipCount - 1;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** lights the scene with the shown level's environment, or the defaults */
	#applyEnvironment(): void {
		this.#baseEnvironment = this.#level?.environment ?? null;
		this.#blendKey = null;
		this.#fades.reset();
		this.#blendEnvironment(true, 0);
	}

	/**
	 * re-blends the environment volumes at the camera when it moved, a fade is running or the options changed,
	 * and relights the scene if the result differs
	 *
	 * @param force blend even if nothing changed
	 * @param dt seconds since the last frame, which time-faded volumes advance by
	 */
	#blendEnvironment(force: boolean, dt: number): void {
		const options = this.options;
		const eye = this.camera.position;
		const settings = `${options.photoFilter}|${options.environmentVolumes}|${options.environmentPin}|${this.#conditionResults.join()}`;
		const last = this.#blendEye;
		if (
			!force &&
			settings === this.#blendSettings &&
			!this.#fades.animating &&
			eye[0] === last[0] &&
			eye[1] === last[1] &&
			eye[2] === last[2]
		) {
			return;
		}
		this.#blendEye = [...eye];
		this.#blendSettings = settings;
		const manifest = this.scene?.pkg.manifest;
		const base = this.#baseEnvironment;
		const blended =
			manifest === undefined || base === null
				? null
				: blendEnvironment(
						manifest,
						base,
						eye,
						{
							volumes: options.environmentVolumes,
							pinnedPhase: options.environmentPin,
							loaded: this.#conditionResults,
						},
						{ fades: this.#fades, dt },
					);
		const profile = blended?.profile ?? null;
		let key = blended?.key ?? '';
		this.#appliedVolumes = blended?.applied ?? [];
		const filter = this.#photoFilters.find((entry) => entry.id === options.photoFilter) ?? null;
		key += `|photo:${filter?.id ?? ''}`;
		if (key === this.#blendKey) {
			return;
		}
		this.#blendKey = key;
		this.#environment = deriveEnvironment(profile, filter);
		this.#celestial = celestialLook(profile);
		this.#wetness = wetnessParams(profile?.rain);
		this.#post.celestial.setLook(this.#celestial);
		this.#post.lensFlares.setLook(lensFlareLook(profile));
		this.#post.setEnvironment(this.#environment);
		this.#fog.setEnvironment(this.#environment, this.camera.near);
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns the name of the environment profile lighting the shown level, or `null` for the defaults */
	get environmentName(): string | null {
		return this.#environment.name;
	}

	/** @returns the environment volumes applied at the camera, in order */
	get appliedVolumes(): readonly AppliedVolume[] {
		return this.#appliedVolumes;
	}

	/** @returns the phases the shown level's volumes apply, for pinning one: index and name */
	environmentPhases(): { index: number; name: string }[] {
		const manifest = this.scene?.pkg.manifest;
		const level = this.#level;
		if (manifest === undefined || level === null) {
			return [];
		}
		const indices = new Set<number>();
		for (const volume of manifest.environmentVolumes) {
			const owner = volumeLevelTag(manifest, volume);
			if (volume.phase !== null && (owner === level.tag || owner === 0)) {
				indices.add(volume.phase);
			}
		}
		return [...indices]
			.map((index) => ({ index, name: manifest.environmentPhases[index].name }))
			.toSorted((a, b) => a.name.localeCompare(b.name));
	}

	/** @returns the loaded package's levels (the same array until the package changes) */
	levels(): LevelEntry[] {
		return this.scene?.levels ?? [];
	}

	// #endregion

	// #region camera and levels

	/** @returns terrain height beneath the camera, or `null` off terrain or while its pages load */
	get groundHeight(): number | null {
		return this.#groundHeight(this.camera.position[0], this.camera.position[2]) ?? null;
	}

	/**
	 * @param x world x
	 * @param z world z
	 * @returns the top of the scenery in the 128 m cell over the point, or -∞ where there's none
	 */
	#sceneryTop(x: number, z: number): number {
		const scene = this.scene;
		if (scene === null) {
			return -Infinity;
		}
		const info = scene.pkg.manifest.tree;
		const cell = scene.tree.byId.get(tileId(tileAt(info, info.cellLevel, x, z)));
		return cell?.bounds.max[1] ?? -Infinity;
	}

	/**
	 * @param x world x
	 * @param z world z
	 * @returns terrain height from the always-resident coarse pages, `null` off the terrain or over a hole, or
	 *   `undefined` while no page covering the point is resident yet
	 */
	#groundHeight(x: number, z: number): number | null | undefined {
		const scene = this.scene;
		const terrain = scene?.pkg.manifest.terrain;
		if (scene == null || terrain == null) {
			return null;
		}
		const info = scene.pkg.manifest.tree;
		let covered = false;
		for (let level = scene.tree.terrainLeafLevel; level >= scene.tree.terrainRootLevel; level--) {
			const node = scene.tree.byId.get(tileId(tileAt(info, level, x, z)));
			const blob = node?.terrain?.blob;
			covered ||= blob !== undefined;
			const resident = blob === undefined ? null : scene.stream.get(blob)?.resident;
			const samples = resident?.kind === 'heights' ? resident.samples : null;
			if (node === undefined || samples === null) {
				continue;
			}
			const side = TERRAIN_PAGE_SAMPLES;
			const spacing = node.size / (side - 1);
			const fx = Math.min(side - 1, Math.max(0, (x - node.minX) / spacing));
			const fz = Math.min(side - 1, Math.max(0, (z - node.minZ) / spacing));
			const sample = samples[Math.round(fz) * side + Math.round(fx)];
			return isTerrainHole(sample) ? null : terrainHeight(terrain, sample);
		}
		return covered ? undefined : null;
	}

	/** @returns a pose looking over the whole region, or `null` without a package */
	#overviewPose(): CameraPose | null {
		const manifest = this.scene?.pkg.manifest;
		if (manifest === undefined) {
			return null;
		}
		const { origin, rootSize } = manifest.tree;
		const terrain = manifest.terrain;
		const baseY = terrain === null ? 0 : terrain.baseHeight + terrain.heightScale / 2;
		return {
			position: [
				origin[0] + rootSize / 2,
				baseY + rootSize * 0.45,
				origin[1] + rootSize / 2 - rootSize * 0.85,
			],
			yaw: 0,
			pitch: -0.5,
		};
	}

	/** @returns {@link TileNode.cellId} s of the level's cells */
	#cellIds(level: LevelInfo): Set<string> {
		const cellLevel = this.scene?.pkg.manifest.tree.cellLevel ?? 0;
		return new Set(level.cells.map(([x, z]) => tileId({ level: cellLevel, x, z })));
	}

	#levelInfo(id: string): LevelInfo | undefined {
		return this.scene?.pkg.manifest.levels.find((candidate) => candidate.id === id);
	}

	/**
	 * @returns a pose looking over the level's playable rectangle (over the terrain, or the spawn height off
	 *   it) from the heading that keeps the widest view where the level's own environment applies, and whether
	 *   it's settled: unsettled poses fell back to the spawn height while the coarse pages load
	 */
	#levelPose(level: LevelInfo): { pose: CameraPose; settled: boolean } {
		const { rect, playerInitPos } = level;
		const cx = (rect.minX + rect.maxX) / 2;
		const cz = (rect.minZ + rect.maxZ) / 2;
		const extent = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
		const terrain = this.#groundHeight(cx, cz);
		const ground = terrain ?? playerInitPos[1];
		const back = extent * 0.75;
		const up = extent * 0.55;
		const pitch = -Math.atan2(up, back);
		const settled = terrain !== undefined;
		// looking north from the south, unless the level's volume can't hold that view
		const fromHeading = (yaw: number): Vec3 => [
			cx - Math.sin(yaw) * back,
			ground + up,
			cz - Math.cos(yaw) * back,
		];
		const fallback = { pose: { position: fromHeading(0), yaw: 0, pitch }, settled };
		const manifest = this.scene?.pkg.manifest;
		const base = level.environment ?? undefined;
		if (manifest === undefined || base === undefined || !this.options.environmentVolumes) {
			return fallback;
		}
		const target: Vec3 = [cx, ground, cz];
		let best: { position: Vec3; yaw: number; distance: number } | null = null;
		for (let i = 0; i < VIEW_HEADINGS; i++) {
			const yaw = (i / VIEW_HEADINGS) * 2 * Math.PI;
			const position = eyeInLevelVolume(manifest, level.tag, base, target, fromHeading(yaw), {
				loaded: this.#conditionResults,
				// over the treetops and the cell's tallest scenery (Yinglung's chasm walls are meshes). holes in
				// the terrain aren't clear; terrain that isn't resident yet is
				clear: ([x, y, z]) => {
					const height = this.#groundHeight(x, z);
					return (
						height !== null && y >= (height ?? -Infinity) + VIEW_CLEARANCE && y >= this.#sceneryTop(x, z)
					);
				},
			});
			if (position === null) {
				continue;
			}
			const distance = Math.hypot(position[0] - cx, position[1] - ground, position[2] - cz);
			if (best === null || distance > best.distance + 1) {
				best = { position, yaw, distance };
			}
			// the usual heading wins while it keeps half its reach: other headings can land inside scenery the
			// terrain check doesn't see
			if (i === 0 && distance >= Math.hypot(back, up) / 2) {
				break;
			}
		}
		if (best === null) {
			return fallback;
		}
		return { pose: { position: best.position, yaw: best.yaw, pitch }, settled };
	}

	#setPose({ position, yaw, pitch }: CameraPose): void {
		this.camera.position = [...position];
		this.camera.yaw = yaw;
		this.camera.pitch = pitch;
		// a cut: the last frames show somewhere else
		this.#post.taa.reset();
		this.#post.resetFocus();
		this.#post.reflections.reset();
		this.#fog.reset();
	}

	/** re-poses the first view over the ground once the coarse terrain lands; drops it if the camera moved */
	#settleFirstPose(): boolean {
		const pending = this.#unsettledPose;
		const level = this.#level;
		if (pending === null || level === null) {
			return false;
		}
		const camera = this.camera;
		if (
			camera.yaw !== pending.yaw ||
			camera.pitch !== pending.pitch ||
			camera.position.some((value, axis) => value !== pending.position[axis])
		) {
			this.#unsettledPose = null;
			return false;
		}
		const { pose, settled } = this.#levelPose(level);
		if (!settled) {
			return false;
		}
		this.#setPose(pose);
		this.#unsettledPose = null;
		return true;
	}

	/**
	 * flies to view a point from the south, above and behind it
	 *
	 * @param target Unity-space point to look at
	 * @param distance how far back to stand, in metres
	 */
	flyToPoint(target: Vec3, distance: number): void {
		this.#unsettledPose = null;
		const back = Math.max(distance, 10);
		const up = back * 0.6;
		this.controls.flyTo({
			position: [target[0], target[1] + up, target[2] - back],
			yaw: 0,
			pitch: -Math.atan2(up, back),
		});
		this.#dirty = true;
	}

	/**
	 * @param target authored OEM point
	 * @param signal cancels a superseded point's geometry reads and camera cut
	 * @param options release-bound pose and whether this is a same-scene animated transition
	 * @returns when nearby opaque geometry has been checked and the new view applied
	 */
	async framePoint(
		target: Vec3,
		signal: AbortSignal,
		options?: { baked?: PointView; animate: boolean },
	): Promise<PointView | null> {
		signal.throwIfAborted();
		const scene = this.scene;
		if (!scene) {
			return null;
		}
		this.#unsettledPose = null;
		const initial: CameraPose = {
			position: [target[0], target[1] + 6, target[2] - 10],
			yaw: 0,
			pitch: -Math.atan2(6, 10),
		};
		if (options?.animate) {
			this.controls.flyTo(initial);
		} else {
			this.controls.cancelFlight();
			this.#setPose(initial);
		}
		this.#dirty = true;
		const states = scene.pkg.manifest.states;
		const areas = states.streamAreas;
		let picks = this.#scenePicks;
		if (areas && this.options.streamAreas) {
			let zones = zonesAt(areas, target);
			if (zones.size === 0) {
				zones = zonesAround(areas, target);
			}
			picks = { ...streamAreaValues(areas, areasShownIn(areas, zones)), ...picks };
		}
		const shown = groupsShown(
			states,
			this.#level?.tag ?? null,
			conditionResults(states, resolveSceneValues(states, picks)),
		);
		const key = await pointViewKey(scene.pkg.manifest.generation, this.level, target, shown);
		let pose = options?.baked?.key === key ? options.baked : readPointView(key);
		if (pose === null) {
			let pendingTerrain = false;
			pose = await pointPreview(
				scene.pkg,
				this.#pool,
				target,
				states,
				this.#level?.tag ?? null,
				picks,
				(x, z) => {
					const height = this.#groundHeight(x, z);
					pendingTerrain ||= height === undefined;
					return height ?? null;
				},
				signal,
			);
			if (!pendingTerrain && !signal.aborted && this.scene === scene) {
				writePointView(key, pose);
			}
		}
		signal.throwIfAborted();
		if (this.scene !== scene) {
			return null;
		}
		this.#unsettledPose = null;
		if (options?.animate) {
			this.controls.flyTo(pose);
		} else {
			this.controls.cancelFlight();
			this.#setPose(pose);
		}
		this.#dirty = true;
		return { key, clear: false, ...pose };
	}

	/**
	 * flies to a vantage point over a level and prioritises its cells.
	 *
	 * @param id level id
	 */
	flyToLevel(id: string): void {
		const level = this.#levelInfo(id);
		if (level !== undefined) {
			this.#flyOver(level);
		}
	}

	#flyOver(level: LevelInfo): void {
		this.controls.flyTo(this.#levelPose(level).pose);
		this.#focusCells = this.#cellIds(level);
		this.#dirty = true;
	}

	/** @returns the shown level's id, or `null` when the package has no level with content */
	get level(): string | null {
		return this.#level?.id ?? null;
	}

	/**
	 * shows one level, whole and alone over the shared terrain, and flies over it. other levels' content stops
	 * being drawn and is evicted as the budget needs.
	 *
	 * @param id level id
	 * @param options fly false changes visibility without moving the camera or its active controls
	 */
	showLevel(id: string, options: { fly?: boolean } = {}): void {
		const level = this.#levelInfo(id);
		if (level === undefined || this.scene === null) {
			return;
		}
		this.#level = level;
		this.#updateVisibility();
		this.#post.autoExposure.reset();
		this.#applyEnvironment();
		if (options.fly === false) {
			this.#focusCells = null;
			this.#unsettledPose = null;
		} else {
			this.#flyOver(level);
		}
		this.#emitState();
	}

	// #endregion

	// #region options and stats

	/** values the user picked, by control id */
	#scenePicks: Record<string, number> = {};
	/** every control's value, from the picks and the package's defaults and derived controls */
	#sceneValues: Record<string, number> = {};

	/** @returns every scene control's current value */
	get sceneValues(): Readonly<Record<string, number>> {
		return this.#sceneValues;
	}

	/** @returns the values the user picked, by control id; other controls follow their default or formula */
	get scenePicks(): Readonly<Record<string, number>> {
		return this.#scenePicks;
	}

	/**
	 * @param id a scene control's id
	 * @param value one of its values, or `null` to drop the pick so it follows its default or formula again
	 */
	setSceneValue(id: string, value: number | null): void {
		this.setSceneValues({ [id]: value });
	}

	/**
	 * sets several controls at once, re-evaluating visibility once
	 *
	 * @param values by control id, one of its values or `null` to drop the pick; unknown controls and values
	 *   are ignored
	 */
	setSceneValues(values: Readonly<Record<string, number | null>>): void {
		const controls = this.scene?.pkg.manifest.states.controls;
		if (controls === undefined) {
			return;
		}
		const picks = { ...this.#scenePicks };
		for (const [id, value] of Object.entries(values)) {
			const control = controls.find((entry) => entry.id === id);
			if (
				control === undefined ||
				(value !== null && !control.values.some((entry) => entry.value === value))
			) {
				continue;
			}
			if (value === null) {
				delete picks[id];
			} else {
				picks[id] = value;
			}
		}
		this.#scenePicks = picks;
		this.#updateVisibility();
		this.#emitState();
	}

	/** @returns every gameplay water volume of the package, with its fill now and the fill it's moving to */
	get waterVolumes(): WaterVolumeState[] {
		return this.#waterLevels.states;
	}

	/** restores scene control and environment preview defaults for the current package */
	resetSceneValues(): void {
		this.#scenePicks = {};
		this.#waterLevels.reset();
		this.options.environmentPin = null;
		this.#fades.reset();
		this.#updateVisibility();
		this.#emitState();
	}

	/** per conditional set of the loaded package, whether the selected scene values satisfy it */
	#conditionResults: boolean[] = [];

	/** @returns per conditional set of the loaded package, whether the selected scene values satisfy it */
	get conditionResults(): readonly boolean[] {
		return this.#conditionResults;
	}

	/** stream areas the conditions were last evaluated with, or `null` for every area */
	#visibleAreas: ReadonlySet<number> | null = null;
	/** camera position {@link followStreamAreas} last tested */
	#areasEye: Vec3 = [Number.NaN, 0, 0];

	/**
	 * @returns the stream areas shown at the camera, or `null` when every area shows (the option is off or the
	 *   package has no stream areas)
	 */
	get visibleStreamAreas(): ReadonlySet<number> | null {
		return this.#visibleAreas;
	}

	/** @returns the stream areas to show at the camera, or `null` for every area */
	#streamAreasAtCamera(): ReadonlySet<number> | null {
		const info = this.scene?.pkg.manifest.states.streamAreas ?? null;
		if (info === null || !this.options.streamAreas) {
			return null;
		}
		const eye = this.camera.position;
		let zones = zonesAt(info, eye);
		if (zones.size === 0) {
			// above or below every trigger the game falls back to the root areas, which hides most of a zone's
			// level from an overview, so a free camera keeps the zones whose footprint it's over
			zones = zonesAround(info, eye);
		}
		return areasShownIn(info, zones);
	}

	/** proximity control values the conditions were last evaluated with */
	#proximity: Record<string, number> = {};

	/** @returns the proximity controls' values at the camera, which stands in for the player */
	#proximityAtCamera(): Record<string, number> {
		return proximityValues(this.scene?.pkg.manifest.states.proximities ?? [], this.camera.position);
	}

	/**
	 * re-evaluates visibility when the camera moved into a different set of stream areas, or nearer to or
	 * further from an interactive than its proximity radius
	 */
	#followStreamAreas(): void {
		const eye = this.camera.position;
		const last = this.#areasEye;
		if (eye[0] === last[0] && eye[1] === last[1] && eye[2] === last[2]) {
			return;
		}
		this.#areasEye = [...eye];
		const visible = this.#streamAreasAtCamera();
		const current = this.#visibleAreas;
		const same =
			visible === null || current === null
				? visible === current
				: visible.size === current.size && visible.isSubsetOf(current);
		const proximity = this.#proximityAtCamera();
		const sameProximity = Object.entries(proximity).every(([id, value]) => this.#proximity[id] === value);
		if (!same || !sameProximity) {
			this.#updateVisibility();
		}
	}

	/**
	 * re-evaluates conditions and visibility groups for the shown level, scene values and stream areas at the
	 * camera, for every consumer
	 */
	#updateVisibility(): void {
		const scene = this.scene;
		const states = scene?.pkg.manifest.states;
		this.#visibleAreas = this.#streamAreasAtCamera();
		this.#areasEye = [...this.camera.position];
		const areas = states?.streamAreas ?? null;
		this.#proximity = this.#proximityAtCamera();
		// stream areas and proximities follow the camera unless pinned, so the camera's values go under the picks
		const picks = {
			...(areas === null ? {} : streamAreaValues(areas, this.#visibleAreas)),
			...this.#proximity,
			...this.#scenePicks,
		};
		this.#sceneValues = states === undefined ? {} : resolveSceneValues(states, picks);
		const values = this.#sceneValues;
		// water volumes move to the fill their `waterLevel` control picks, at the game's speed times the rate
		this.#waterLevels.follow(values, !Number.isFinite(this.options.waterLevelRate));
		this.#conditionResults = states === undefined ? [] : conditionResults(states, values);
		const shown =
			states === undefined ? [] : groupsShown(states, this.#level?.tag ?? null, this.#conditionResults);
		scene?.selector.setGroupsShown(shown);
		this.#water.setGroupsShown(shown);
		this.#lights.setGroupsShown(shown);
		this.#irradiance.setGroupsShown(shown);
		this.#dirty = true;
	}

	/**
	 * focuses on a world-space point using its distance along the optical axis.
	 *
	 * @param point Unity world position
	 * @returns false if the point is behind the near plane or has invalid coordinates
	 */
	focusAt(point: Vec3): boolean {
		const forward = this.camera.forward();
		const distance = point.reduce((sum, value, i) => sum + (value - this.camera.position[i]) * forward[i], 0);
		if (!Number.isFinite(distance) || distance < this.camera.near) {
			return false;
		}
		this.setOptions({ depthOfField: true, focusDistance: distance });
		return true;
	}

	/** @param patch options to change */
	setOptions(patch: Partial<ViewerOptions>): void {
		if (
			patch.photoFilter !== undefined &&
			patch.photoFilter !== null &&
			!this.#photoFilters.some((filter) => filter.id === patch.photoFilter)
		) {
			throw new Error(`unknown photo filter ${patch.photoFilter}`);
		}
		if (patch.photoFilter !== undefined || patch.photoLutStrength !== undefined) {
			const id = patch.photoFilter === undefined ? this.options.photoFilter : patch.photoFilter;
			const filter = this.#photoFilters.find((entry) => entry.id === id) ?? null;
			if (
				patch.photoLutStrength !== undefined &&
				(!Number.isFinite(patch.photoLutStrength) || patch.photoLutStrength < 0 || patch.photoLutStrength > 1)
			) {
				throw new RangeError('photo LUT contribution must be between 0 and 1');
			}
			this.#post.photoLut.set(filter, patch.photoLutStrength ?? this.options.photoLutStrength);
			if (patch.photoFilter !== undefined && patch.photoFilter !== this.options.photoFilter) {
				this.#post.photoParticles.set(filter, this.camera, this.#time);
			}
		}
		Object.assign(this.options, patch);
		this.options.aperture = Number.isFinite(this.options.aperture)
			? Math.min(32, Math.max(1.4, this.options.aperture))
			: DEFAULT_OPTIONS.aperture;
		this.options.focusDistance = Number.isFinite(this.options.focusDistance)
			? Math.min(10000, Math.max(0.1, this.options.focusDistance))
			: DEFAULT_OPTIONS.focusDistance;
		if (
			patch.depthOfField !== undefined ||
			patch.aperture !== undefined ||
			patch.focusDistance !== undefined
		) {
			this.#post.resetFocus();
			this.#post.taa.reset();
		}
		this.#targets.renderScale = Math.min(1, Math.max(0.25, this.options.renderScale));
		this.#post.taa.enabled = this.options.antialiasing;
		if (patch.debugView !== undefined || patch.antialiasing !== undefined) {
			this.#post.taa.reset();
			this.#post.resetFocus();
		}
		if (patch.streamAreas !== undefined) {
			this.#updateVisibility();
		}
		if (this.scene !== null) {
			this.scene.stream.options.budgetBytes = this.options.budgetMiB * 2 ** 20;
		}
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns the installed photo library, without copying its texture payloads */
	get photoFilters(): readonly PhotoFilter[] {
		return this.#photoFilters;
	}

	/** @param filters validated filters exported from an install; replaces the current library */
	setPhotoFilters(filters: readonly PhotoFilter[]): void {
		this.setOptions({ photoFilter: null });
		this.#photoFilters = filters;
		this.#blendKey = '';
		this.#emitState();
	}

	/**
	 * @param listener called when {@link stateRevision} or {@link statsRevision} change (stats at most about
	 *   four times a second)
	 * @returns unsubscribe
	 */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emitState(): void {
		this.stateRevision++;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}

	#emptyStats(): ViewerStats {
		const features = this.#gfx.features;
		return {
			adapter: this.#gfx.adapterName,
			features: mapDefined(Object.entries(features), ([name, on]) => (on ? name : undefined)),
			frameMs: 0,
			cpuMs: 0,
			cpuPhases: {},
			gpuMs: null,
			gpuPasses: {},
			autoExposureEv: 0,
			draws: 0,
			triangles: 0,
			instances: 0,
			meshInstances: 0,
			texturedDraws: 0,
			textureBytes: 0,
			terrainPatches: 0,
			nodesVisited: 0,
			residentBytes: 0,
			pinnedBytes: 0,
			poolBytes: 0,
			queued: 0,
			requestsInFlight: 0,
			decoding: 0,
			uploading: 0,
			downloadedBytes: 0,
			requests: 0,
			evictions: 0,
			failed: 0,
			packageChanged: false,
			geometriesReady: 0,
			geometriesTotal: 0,
			camera: { position: [0, 0, 0], yaw: 0, pitch: 0, speed: 0 },
		};
	}

	// #endregion

	// #region frame loop

	#tick(time: number): void {
		this.#raf = requestAnimationFrame((next) => this.#tick(next));
		const dt = this.#lastTime === 0 ? 1 / 60 : Math.min(0.1, (time - this.#lastTime) / 1000);
		this.#lastTime = time;
		const cpuStart = performance.now();
		this.#spanAt = cpuStart;
		this.#frameSpans.clear();

		const moved = this.controls.update(dt) || this.#settleFirstPose();
		const watered = this.#waterLevels.update(dt, this.options.waterLevelRate);
		this.#waterLevels.applyFloaters((resident, row) =>
			this.#instances.writeRows(
				resident.alloc.start + row,
				new Uint32Array(resident.rowsF32.buffer, row * ROW_BYTES, ROW_WORDS),
				1,
			),
		);
		if (moved) {
			for (const listener of this.#cameraListeners) {
				listener();
			}
		}
		this.#followStreamAreas();
		const resized = this.#targets.update();
		this.#blendEnvironment(false, dt);
		this.#span('controls');
		const scene = this.scene;
		const options = this.options;
		// pipeline variants compile on first use (stencil effects), and draw once ready
		const compiled = this.#pipelines.size !== this.#seenPipelines;
		this.#seenPipelines = this.#pipelines.size;
		const changed =
			this.#dirty ||
			moved ||
			watered ||
			resized ||
			options.continuous ||
			compiled ||
			(scene !== null && scene.stream.version !== this.#seenVersion);
		this.#dirty = false;
		// the temporal antialiasing converges over a few more jittered frames of the same view
		let settling = false;
		if (changed) {
			this.#settleFrames = options.antialiasing || options.depthOfField ? SETTLE_FRAMES : 0;
		} else if (this.#settleFrames > 0) {
			this.#settleFrames--;
			settling = true;
		}
		// keep rendering while the exposure adapts. it meters only while the view changes or settles: water and
		// particles change what it meters every frame, so a meter that kept running would never let it settle
		const post = this.#postSettings();
		const adapting = this.#post.autoExposure.update(
			post.autoExposure && post.debugView === 'lit' ? this.#environment.autoExposure : null,
			dt,
			{ metering: changed || settling },
		);
		const render =
			changed ||
			settling ||
			adapting ||
			(options.animate && post.debugView === 'lit' && this.#post.photoParticles.active);
		if (render && options.animate) {
			this.#time += dt;
			this.#windClock += windClockRate(this.#environment.wind) * dt;
		}
		// frames that only settle or adapt reuse the last selection, unless it holds particles, which move by
		// the clock like the effects' scrolling textures. with nothing rendering and nothing loading, the
		// traversal would repeat the last frame's
		const traverse =
			scene !== null &&
			((render && (changed || this.#particlesShown || this.#spinsShown)) || !scene.stream.idle);
		if (scene !== null && traverse) {
			this.#frame++;
			this.#traverseAndPrepare(scene, { prepare: render });
		}
		if (render) {
			this.#lastDraws = this.#render(scene !== null);
			this.#frameMs = this.#frameMs * 0.9 + dt * 1000 * 0.1;
		}
		if (render || traverse) {
			this.#cpuMs = this.#cpuMs * 0.9 + (performance.now() - cpuStart) * 0.1;
			const spans = this.#cpuSpans;
			for (const name of spans.keys()) {
				if (!this.#frameSpans.has(name)) {
					spans.set(name, (spans.get(name) ?? 0) * 0.9);
				}
			}
			for (const [name, ms] of this.#frameSpans) {
				spans.set(name, (spans.get(name) ?? ms) * 0.9 + ms * 0.1);
			}
		}

		if (time - this.#lastStats > STATS_INTERVAL) {
			this.#lastStats = time;
			this.#publishStats();
		}
	}

	/** ends the current CPU span, attributing its time to `name` */
	#span(name: string): void {
		const now = performance.now();
		this.#frameSpans.set(name, (this.#frameSpans.get(name) ?? 0) + now - this.#spanAt);
		this.#spanAt = now;
	}

	/**
	 * turns the spinning rows of the selected blocks to the clock and rewrites them
	 *
	 * @param ranges the selected instance ranges
	 * @returns whether any selected block has spinning rows
	 */
	#turnSpinningRows(ranges: readonly InstanceRange[]): boolean {
		let shown = false;
		for (const { item } of ranges) {
			const resident = item.resident;
			if (resident?.kind !== 'instances' || resident.spins === null) {
				continue;
			}
			shown = true;
			if (this.#spinTimes.get(resident) === this.#time) {
				continue;
			}
			this.#spinTimes.set(resident, this.#time);
			const [first, end] = turnRows(resident.rowsF32, resident.spins, this.#time);
			this.#instances.writeRows(
				resident.alloc.start + first,
				new Uint32Array(resident.rowsF32.buffer, first * ROW_BYTES, (end - first) * ROW_WORDS),
				end - first,
			);
		}
		return shown;
	}

	/** selects and streams this frame's content, and when `prepare` is set, writes it for the renderers */
	#traverseAndPrepare(scene: LoadedScene, { prepare }: { prepare: boolean }): void {
		const options = this.options;
		const stream = scene.stream;
		stream.beginFrame(this.#frame);
		this.#seenVersion = stream.version;
		// screen-space sizes are measured in output pixels, so the render scale trades shading only, not detail
		const aspect = this.#targets.outputWidth / this.#targets.outputHeight;
		const planes = this.camera.frustumPlanes(aspect);
		const shadows = options.shadows && options.debugView === 'lit';
		const view = {
			camera: this.camera,
			planes,
			pixelFactor: this.camera.pixelFactor(this.#targets.outputHeight),
			casters: shadows ? offscreenCasters(planes, this.#environment.sunDirection) : null,
		};
		const selection = scene.selector.run(
			view,
			{
				...options,
				terrainSurface: options.terrainSurface && this.#terrain.surfaces,
				terrainSplat: options.terrainSplat && this.#terrain.surfaces,
			},
			this.#focusCells,
		);
		this.#visited = selection.visited;
		// spinning rows turn before instances are culled and listed by where they are
		this.#spinsShown = this.#turnSpinningRows(selection.instances);
		this.#span('tree');
		// per-instance LOD selection also requests geometry, so it runs before the stream update
		let meshSelection: MeshSelection | null = null;
		if (shadows) {
			// mesh selection groups instances by the shadow layers they reach; #render fits the same layers again,
			// which changes nothing while the camera holds still
			this.#shadows.fit(this.camera, aspect, this.#environment.sunDirection);
		}
		if (scene.meshes !== null && options.instances) {
			meshSelection = scene.meshes.run(selection.instances, {
				eye: this.camera.position,
				planes: view.planes,
				pixelFactor: view.pixelFactor,
				viewportHeight: this.#targets.outputHeight,
				minPixels: options.minBoxPixels,
				textureBias: options.textureBias,
				unsupportedMaterials: options.unsupportedMaterials,
				missingContent: options.missingContent,
				casters: view.casters,
				shadowLayers: shadows ? this.#shadows.volumes : null,
				// particles move by the clock the effects' shaders scroll by
				particles: {
					time: this.#time,
					eye: this.camera.position,
					widthPerDepth: 2 * Math.tan(this.camera.fovY / 2) * aspect,
					right: this.camera.right(),
					up: this.camera.up(),
					forward: this.camera.forward(),
				},
			});
		}
		this.#particlesShown = meshSelection?.particles ?? false;
		this.#span('mesh select');
		this.#updateSkyTextures(scene);
		if (options.water) {
			this.#water.prepare({
				eye: this.camera.position,
				planes: view.planes,
				stream,
				geometries: scene.pkg.geometries.entries,
				textures: scene.textures,
				sun: this.#environment.sunRaw,
				volumeOffsets: this.#waterLevels.offsets,
			});
		} else {
			this.#water.clear();
		}
		this.#span('sky, water');
		this.#irradiance.prepare(stream, this.camera.position);
		stream.update();
		scene.textures.commit();
		this.#span('stream');
		if (!prepare) {
			return;
		}

		const eye = this.camera.position;
		this.#terrain.prepare(options.terrain ? selection.patches : [], eye);
		this.#instances.rebase(eye);
		if (meshSelection === null) {
			this.#instances.prepareRanges(options.instances && options.boxes ? selection.instances : []);
			this.#meshes.clear();
		} else {
			this.#instances.prepareList(options.boxes ? meshSelection.boxes : [], meshSelection.buckets);
			this.#meshes.prepare(meshSelection.buckets, scene.textures);
		}
		this.#shadowsStale = true;
		this.#span('prepare');
	}

	#render(hasScene: boolean): number {
		const device = this.#gfx.device;
		const ring = this.#ring;
		ring.beginFrame();
		const shadows = hasScene && this.options.shadows && this.options.debugView === 'lit';
		if (shadows) {
			this.#shadows.fit(
				this.camera,
				this.#targets.width / this.#targets.height,
				this.#environment.sunDirection,
			);
		}
		const uniforms = ring.allocate(FRAME_UNIFORM_BYTES);
		this.#writeFrameUniforms(uniforms.f32, uniforms.u32, { shadows });
		// each cascade's frame: the main one with the cascade's view-projection
		const cascadeOffsets: number[] = [];
		if (shadows) {
			for (const layer of this.#shadows.layers) {
				const block = ring.allocate(FRAME_UNIFORM_BYTES);
				block.f32.set(uniforms.f32);
				block.f32.set(layer.render, FrameOffsets.viewProj);
				cascadeOffsets.push(block.offset);
			}
		}
		ring.flush();
		this.#span('uniforms');

		const encoder = this.#profiler.instrument(device.createCommandEncoder({ label: 'frame' }));
		this.#irradiance.encode(encoder);
		if (hasScene) {
			this.#meshes.animate(encoder, this.#time);
		}
		let draws = 0;
		// the layers hold what they drew last until the casters or a layer's fit change; frames that only settle
		// the antialiasing or drift the fog redraw nothing there
		if (shadows) {
			const fits = this.#shadowFits;
			this.#shadows.layers.forEach((layer, i) => {
				if (layer.render.some((value, k) => value !== fits[i * 16 + k])) {
					fits.set(layer.render, i * 16);
					this.#shadowsStale = true;
				}
			});
		}
		// an animated caster moves every frame
		const drawShadows = this.#shadowsStale || this.#meshes.animating;
		// pipelines still compiling would leave casters out
		this.#shadowsStale = !shadows || this.#pipelines.compiling > 0;
		(drawShadows ? cascadeOffsets : []).forEach((offset, i) => {
			const pass = encoder.beginRenderPass({
				label: `shadow layer ${i}`,
				colorAttachments: [],
				depthStencilAttachment: {
					view: this.#shadows.views[i],
					depthClearValue: 1,
					depthLoadOp: 'clear',
					depthStoreOp: 'store',
				},
			});
			pass.setBindGroup(0, this.#shadowFrameBindGroup, [offset]);
			if (this.options.terrain) {
				draws += this.#terrain.encodeShadow(pass);
			}
			draws += this.#meshes.encodeShadow(pass, i);
			pass.end();
		});
		// after the shadow layers, which it reads
		const froxels =
			hasScene &&
			this.options.heightFog &&
			this.options.debugView === 'lit' &&
			this.#fog.encode(encoder, {
				frameGroup: this.#frameBindGroup,
				frameOffset: uniforms.offset,
				camera: this.camera,
				aspect: this.#targets.width / this.#targets.height,
				frame: this.#frame,
			});
		const { colors, depth } = this.#targets.mainPassAttachments();
		const pass = encoder.beginRenderPass({
			label: 'main',
			colorAttachments: colors,
			depthStencilAttachment: depth,
		});
		if (hasScene) {
			pass.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
			// the meshes' depth first, so the terrain and the meshes shade only what stays visible
			draws += this.#meshes.encodePrepass(pass);
			draws += this.#terrain.encode(pass);
			draws += this.#meshes.encode(pass);
			draws += this.#instances.encode(pass);
			draws += this.#instances.encodeOutlines(pass);
			if (this.options.wireframe) {
				draws += this.#terrain.encodeWireframe(pass);
			}
		}
		pass.end();
		if (hasScene) {
			const relight = encoder.beginRenderPass({
				label: 'decal relight',
				colorAttachments: [{ view: this.#targets.scene.radiance, loadOp: 'load', storeOp: 'store' }],
			});
			relight.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
			draws += this.#meshes.encodeRelight(relight, this.#targets.scene);
			relight.end();
		}
		// always run, so the composite reads cleared targets when nothing is transparent
		{
			const attachments = this.#targets.transparentPassAttachments();
			const transparent = encoder.beginRenderPass({
				label: 'transparent',
				colorAttachments: attachments.colors,
				depthStencilAttachment: attachments.depth,
			});
			if (hasScene) {
				transparent.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
				draws += this.#meshes.encodeTransparent(transparent, this.#targets.scene);
			}
			transparent.end();
		}
		const output = this.#targets.swapchainView();
		this.#post.encode(encoder, {
			scene: this.#targets.scene,
			swapchain: output,
			camera: this.camera,
			width: this.#targets.width,
			height: this.#targets.height,
			outputWidth: this.#targets.outputWidth,
			outputHeight: this.#targets.outputHeight,
			settings: this.#postSettings(),
			frame: this.#frame,
			froxels,
			water: this.#water,
			waterFoam:
				hasScene && this.#meshes.hasWaterFoam
					? (foamEncoder, { waterDepth, target }) => {
							const foamPass = foamEncoder.beginRenderPass({
								label: 'water foam',
								colorAttachments: [
									{ view: target, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
								],
								depthStencilAttachment: this.#targets.readOnlyDepthAttachment(),
							});
							foamPass.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
							draws += this.#meshes.encodeWaterFoam(foamPass, { ...this.#targets.scene, depth: waterDepth });
							foamPass.end();
						}
					: null,
			screenEffects: (screenEncoder, target, copy) => {
				if (!hasScene) {
					return;
				}
				const scene = this.#targets.scene;
				const meshes = this.#meshes;
				const begin = (label: string): GPURenderPassEncoder => {
					const screenPass = screenEncoder.beginRenderPass({
						label,
						colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
						depthStencilAttachment: this.#targets.readOnlyDepthAttachment(),
					});
					screenPass.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
					return screenPass;
				};
				if (meshes.hasMultiply) {
					const multiply = begin('effect multiply');
					draws += meshes.encodeMultiply(multiply, scene);
					multiply.end();
				}
				if (meshes.hasRefract) {
					// refraction samples the scene as the multiplies left it
					copy();
					const refract = begin('effect refract');
					draws += meshes.encodeRefract(refract, { ...scene, background: scene.radiance });
					refract.end();
				}
			},
			afterDepthOfField: (screenEncoder, target, copy) => {
				if (!hasScene || !this.#meshes.hasAfterDof) {
					return;
				}
				copy();
				const afterFocus = screenEncoder.beginRenderPass({
					label: 'after depth of field',
					colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
					depthStencilAttachment: this.#targets.readOnlyDepthAttachment(),
				});
				afterFocus.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
				draws += this.#meshes.encodeAfterDof(afterFocus, {
					...this.#targets.scene,
					background: this.#targets.scene.radiance,
				});
				afterFocus.end();
			},
			frameGroup: { group: this.#frameBindGroup, offset: uniforms.offset },
		});
		for (const encode of this.#overlays) {
			encode({
				device,
				encoder,
				target: output,
				format: this.#targets.colorFormat,
				depth: this.#targets.scene.depth,
				width: this.#targets.outputWidth,
				height: this.#targets.outputHeight,
				jitter: this.#post.taa.jitter,
			});
		}
		this.#profiler.resolve(encoder);
		this.#span('encode');
		device.queue.submit([encoder.finish()]);
		this.#profiler.afterSubmit();
		this.#post.autoExposure.afterSubmit();
		this.#span('submit');
		return draws;
	}

	/** the post chain's settings, from the options; auto exposure needs a scene */
	#postSettings(): PostSettings {
		const options = this.options;
		return {
			exposure: options.exposure,
			depthOfField: options.depthOfField,
			aperture: options.aperture,
			focusDistance: options.focusDistance,
			autoExposure: options.autoExposure && this.scene !== null,
			tonemapper: options.tonemapper,
			sky: options.sky,
			heightFog: options.heightFog,
			atmosphereFog: options.atmosphereFog,
			flowNoise: options.flowNoise,
			time: this.#time,
			ao: options.ao,
			reflections: options.reflections,
			bloom: options.bloom,
			vignette: options.vignette,
			debugView: options.debugView,
		};
	}

	#writeFrameUniforms(f32: Float32Array, u32: Uint32Array, { shadows }: { shadows: boolean }): void {
		const camera = this.camera;
		const eye = camera.position;
		const { width, height, outputWidth, outputHeight } = this.#targets;
		camera.writeViewProjection(width / height, this.#viewProj);
		{
			// shift the image by this frame's subpixel jitter: clip.xy += jitter · clip.w
			const viewProj = this.#viewProj;
			const [jx, jy] = this.#post.taa.nextJitter(width, height, outputHeight);
			for (let column = 0; column < 4; column++) {
				viewProj[column * 4] += jx * viewProj[column * 4 + 3];
				viewProj[column * 4 + 1] += jy * viewProj[column * 4 + 3];
			}
		}
		f32.set(this.#viewProj, FrameOffsets.viewProj);
		{
			const at = FrameOffsets.eye;
			f32[at] = eye[0];
			f32[at + 1] = eye[1];
			f32[at + 2] = eye[2];
			f32[at + 3] = this.#time;
		}
		{
			const environment = this.#environment;
			f32.set(environment.sunDirection, FrameOffsets.sun);
			f32[FrameOffsets.sun + 3] = 1;
			f32.set(environment.sunIlluminance, FrameOffsets.sunColor);
			f32[FrameOffsets.sunColor + 3] = environment.sunSpecular;
			f32.set(environment.sh, FrameOffsets.sh);
			f32[FrameOffsets.ambient] = environment.indirectSpecular;
			// emitters marked `_IgnorePostExposure` divide out the post exposure (the game's adapted exposure)
			f32[FrameOffsets.ambient + 1] = 1 / postExposure(this.#postSettings(), this.#post.autoExposure);
			f32[FrameOffsets.ambient + 2] = this.#reflection === this.#noReflection ? 0 : 1;
			f32[FrameOffsets.ambient + 3] = this.#reflectionMips;
		}
		{
			const at = FrameOffsets.viewport;
			f32[at] = outputWidth;
			f32[at + 1] = outputHeight;
			f32[at + 2] = camera.pixelFactor(outputHeight);
			f32[at + 3] = this.options.minBoxPixels;
		}
		const terrain = this.scene?.pkg.manifest.terrain;
		if (terrain != null) {
			const at = FrameOffsets.terrain;
			f32[at] = terrain.baseHeight - eye[1];
			f32[at + 1] = terrain.heightScale / TERRAIN_HOLE_BIT;
			u32[at + 2] = TERRAIN_HOLE_BIT;
		}
		{
			const at = FrameOffsets.flags;
			u32[at] = this.options.wireframe ? 1 : 0;
			u32[at + 1] = DEBUG_VIEWS.indexOf(this.options.debugView);
			u32[at + 2] = 0;
			u32[at + 3] = 0;
		}
		f32[FrameOffsets.params] = this.options.outlineMetres;
		// below the output size, textures sample as sharp as the output needs; the history gathers the detail
		f32[FrameOffsets.params + 1] = Math.log2(height / outputHeight);
		this.#shadows.layers.forEach((layer, i) => {
			f32.set(layer.sample, FrameOffsets.shadowMatrices + i * 16);
			f32.set(layer.sphere, FrameOffsets.shadowSpheres + i * 4);
		});
		f32.set(this.#shadows.fade, FrameOffsets.shadowFade);
		f32[FrameOffsets.shadowFade + 3] = shadows ? 1 : 0;
		{
			const shadow = this.#environment.shadow;
			f32.set(this.#shadows.penumbra(shadow.softness), FrameOffsets.shadowPenumbra);
			const at = FrameOffsets.shadowLook;
			f32[at] = shadow.strength;
			f32[at + 1] = shadow.override;
			f32[at + 2] = shadow.attenuation;
			f32[at + 3] = this.#shadowRamp === this.#noShadowRamp ? 0 : 1;
		}
		{
			const cloud = this.#environment.cloudShadow;
			const at = FrameOffsets.cloudShadow;
			const on =
				cloud !== null &&
				this.#cloudShadow !== this.#noCloudShadow &&
				this.options.cloudShadows &&
				this.options.debugView === 'lit';
			f32.fill(0, at, at + 16);
			if (on) {
				f32.set(cloud.center, at);
				f32[at + 3] = 1;
				f32[at + 4] = cloud.start;
				f32[at + 5] = cloud.start + cloud.width;
				f32[at + 6] = cloud.scale;
				f32.set(cloud.flow, at + 8);
				f32[at + 10] = cloud.alpha;
				f32[at + 11] = cloud.farScale;
				f32.set(cloud.projection, at + 12);
			}
		}
		f32.set(this.#wetness, FrameOffsets.wetness);
		{
			const { wind } = this.#environment;
			f32.set([this.#windClock, wind.intensity, ...wind.direction], FrameOffsets.wind);
		}
		this.#irradiance.centers().forEach((center, i) => {
			const at = FrameOffsets.irradiance + i * 4;
			f32.set(center ?? [0, 0, 0], at);
			f32[at + 3] = center !== null && this.options.irradiance ? 1 : 0;
		});
		{
			const lit = this.scene !== null && this.options.localLights && this.options.debugView === 'lit';
			const lights = lit ? this.#lights.prepare(camera, width, height) : { count: 0, tilesX: 1, tilesY: 1 };
			const at = FrameOffsets.localLights;
			f32[at] = lights.count;
			f32[at + 1] = lights.tilesX;
			f32[at + 2] = lights.tilesY;
			f32[at + 3] = camera.near;
			f32.set(camera.forward(), FrameOffsets.viewForward);
			f32.set(camera.right(), FrameOffsets.viewRight);
			f32.set(camera.up(), FrameOffsets.viewUp);
			f32[FrameOffsets.renderSize] = width;
			f32[FrameOffsets.renderSize + 1] = height;
		}
	}

	/** refreshes {@link stats}, notifying subscribers only if something changed */
	#publishStats(): void {
		const scene = this.scene;
		const stream = scene?.stream.stats;
		const camera = this.camera;
		const stats: ViewerStats = {
			...this.stats,
			frameMs: this.#frameMs,
			cpuMs: this.#cpuMs,
			cpuPhases: Object.fromEntries(this.#cpuSpans),
			gpuMs: this.#profiler.milliseconds,
			gpuPasses: Object.fromEntries(this.#profiler.passes),
			autoExposureEv: Math.log2(this.#post.autoExposure.exposure),
			draws: this.#lastDraws,
			triangles:
				(this.options.terrain ? this.#terrain.patchCount * this.#terrain.patchTriangles : 0) +
				this.#instances.triangles +
				this.#meshes.triangles,
			instances: this.#instances.instanceCount + this.#meshes.instanceCount,
			meshInstances: this.#meshes.instanceCount,
			texturedDraws: this.#meshes.texturedDraws,
			textureBytes: scene?.textures.bytes ?? 0,
			terrainPatches: this.#terrain.patchCount,
			nodesVisited: scene === null ? 0 : this.#visited,
			residentBytes: stream?.residentBytes ?? 0,
			pinnedBytes: stream?.pinnedBytes ?? 0,
			poolBytes:
				this.#terrain.poolBytes +
				this.#instances.poolBytes +
				this.#targets.bytes +
				this.#post.bytes +
				this.#fog.bytes +
				this.#shadows.bytes,
			queued: stream?.queued ?? 0,
			requestsInFlight: stream?.requestsInFlight ?? 0,
			decoding: stream?.decoding ?? 0,
			uploading: stream?.uploading ?? 0,
			downloadedBytes: stream?.downloadedBytes ?? 0,
			requests: stream?.requests ?? 0,
			evictions: stream?.evictions ?? 0,
			failed: stream?.failed ?? 0,
			packageChanged: stream?.packageChanged ?? false,
			camera: {
				position: [...camera.position],
				yaw: camera.yaw,
				pitch: camera.pitch,
				speed: this.controls.effectiveSpeed,
			},
		};
		const key = JSON.stringify(stats);
		if (key === this.#statsKey) {
			return;
		}
		this.#statsKey = key;
		this.stats = stats;
		this.statsRevision++;
		this.#notify();
	}

	/** stops the loop and frees everything */
	destroy(): void {
		cancelAnimationFrame(this.#raf);
		document.removeEventListener('visibilitychange', this.#onVisibilityChange);
		this.#overlays.clear();
		this.unload();
		this.controls.destroy();
		this.#post.destroy();
		this.#fog.destroy();
		this.#lights.destroy();
		this.#water.destroy();
		this.#shadows.destroy();
		this.#pool.destroy();
		this.#targets.destroy();
		this.#gfx.device.destroy();
	}

	// #endregion
}
