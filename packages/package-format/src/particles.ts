import type { AnimationCurve, Gradient } from './curves.ts';
import type { Vec3 } from './values.ts';

/**
 * `tables/particles.json`: the particle systems that chain draws emit ({@link ChainDraw.particles}), loaded
 * with the core. each is a Unity `ParticleSystem` drawing one mesh or one camera-facing quad per particle,
 * reduced to the modules a viewer can evaluate in closed form: a particle's state follows from its emission
 * time and its own random values, so a viewer can place every live particle at any time without stepping a
 * simulation
 */
export interface ParticlesTable {
	systems: ParticleSystemInfo[];
}

/** Unity's gravity, m/s² down the world's y, which {@link ParticleFreeMotionInfo.gravityModifier} multiplies */
export const GRAVITY = 9.81;

/** {@link MinMaxCurveInfo.mode} values, Unity's `ParticleSystemCurveMode` */
export const CurveMode = {
	Constant: 0,
	Curve: 1,
	TwoCurves: 2,
	TwoConstants: 3,
} as const;

export type CurveMode = (typeof CurveMode)[keyof typeof CurveMode];

/**
 * a Unity `MinMaxCurve`: a constant, a curve, or a random value between two of either. curves are read at a
 * normalized time (a particle's age over its lifetime, or the emission time over the system's duration) and
 * scaled by {@link scalar}
 */
export interface MinMaxCurveInfo {
	mode: CurveMode;
	/** the constant (or the upper one), or the curves' multiplier */
	scalar: number;
	/** the lower constant ({@link CurveMode.TwoConstants}) */
	min: number;
	/** the curve, or the upper one; `null` for constants */
	curve: AnimationCurve | null;
	/** the lower curve ({@link CurveMode.TwoCurves}); `null` otherwise */
	minCurve: AnimationCurve | null;
}

/** {@link MinMaxGradientInfo.mode} values, Unity's `ParticleSystemGradientMode` */
export const GradientMode = {
	Color: 0,
	Gradient: 1,
	TwoColors: 2,
	TwoGradients: 3,
	/** a random point of the gradient */
	RandomColor: 4,
} as const;

export type GradientMode = (typeof GradientMode)[keyof typeof GradientMode];

/**
 * a Unity `MinMaxGradient`: a colour, a gradient, a random value between two of either, or a random point of
 * a gradient. gradients are read at a normalized time, as {@link MinMaxCurveInfo}'s curves are
 */
export interface MinMaxGradientInfo {
	mode: GradientMode;
	/** the colour (or the upper one), rgba as authored (sRGB rgb) */
	max: [r: number, g: number, b: number, a: number];
	/** the lower colour ({@link GradientMode.TwoColors}) */
	min: [r: number, g: number, b: number, a: number];
	/** the gradient, or the upper one; `null` for colours */
	maxGradient: Gradient | null;
	/** the lower gradient ({@link GradientMode.TwoGradients}); `null` otherwise */
	minGradient: Gradient | null;
}

/** {@link ParticleSystemInfo.renderMode} values, Unity's `ParticleSystemRenderMode` */
export const ParticleRenderMode = {
	/**
	 * a quad turned by {@link ParticleSystemInfo.alignment}: facing the camera, or along the world's or
	 * emitter's axes
	 */
	Billboard: 0,
	/** a quad facing the camera, stretched along the particle's velocity ({@link ParticleSystemInfo.stretch}) */
	Stretched: 1,
	/** a quad lying flat, facing up the world's y */
	Horizontal: 2,
	/** a quad facing the camera's heading, kept upright */
	Vertical: 3,
	/** the system's meshes ({@link ParticleSystemInfo.meshWeights}) */
	Mesh: 4,
} as const;

export type ParticleRenderMode = (typeof ParticleRenderMode)[keyof typeof ParticleRenderMode];

/** how a {@link ParticleRenderMode.Stretched} particle's quad lengthens */
export interface ParticleStretchInfo {
	/** its length in units of its width */
	lengthScale: number;
	/** metres added to its length per m/s of speed */
	velocityScale: number;
}

/** {@link ParticleShapeInfo.kind} values, Unity's `ParticleSystemShapeType` (those a viewer emits from) */
export const ParticleShapeKind = {
	Sphere: 0,
	Hemisphere: 2,
	/** from the base disc, along the cone */
	Cone: 4,
	Box: 5,
	/** from anywhere inside the cone, up to its length */
	ConeVolume: 8,
	Circle: 10,
	/** from inside a torus around the circle, outwards from its tube's centre line */
	Donut: 17,
} as const;

export type ParticleShapeKind = (typeof ParticleShapeKind)[keyof typeof ParticleShapeKind];

/** where particles start and which way they leave (Unity's `ShapeModule`), in the emitter's frame */
export interface ParticleShapeInfo {
	kind: ParticleShapeKind;
	/** m */
	radius: number;
	/**
	 * the outer fraction of the radius particles start in: 0 on the edge only, 1 anywhere inside. a donut
	 * applies it to its tube's radius
	 */
	radiusThickness: number;
	/** the donut's tube radius, m */
	donutRadius: number;
	/** the cone's half angle, degrees */
	angle: number;
	/** the cone volume's length, m */
	length: number;
	/** the slice of the circle used, degrees from +x towards +y */
	arc: number;
	/** the shape's own placement in the emitter: translation, Euler angles in degrees (Unity's order), scale */
	position: Vec3;
	rotation: Vec3;
	scale: Vec3;
	/** how far each start direction is pulled towards a random direction, 0–1 */
	randomDirection: number;
	/** how far each start direction is pulled away from the shape's centre, 0–1 */
	sphericalDirection: number;
	/** each start position moves by up to this much along each axis, m */
	randomPosition: number;
}

/** a burst of particles (Unity's `ParticleSystem.Burst`), repeated within each loop */
export interface ParticleBurstInfo {
	/** seconds into the loop */
	time: number;
	/** particles per burst, rounded */
	count: MinMaxCurveInfo;
	/** how many times the burst fires */
	cycles: number;
	/** seconds between them */
	interval: number;
	/** the chance each burst fires, 0–1 */
	probability: number;
}

/**
 * {@link ParticleSystemInfo.alignment} values, Unity's `ParticleSystemRenderSpace` (those a viewer orients
 * by): the frame a mesh or {@link ParticleRenderMode.Billboard} quad's rotation applies in. other quads ignore
 * it
 */
export const ParticleAlignment = {
	/** the camera's, so the particle turns with it */
	View: 0,
	/** the world's */
	World: 1,
	/** the emitter's */
	Local: 2,
	/** the emitter's, turned the shortest way from its +z onto the particle's velocity */
	Velocity: 4,
} as const;

export type ParticleAlignment = (typeof ParticleAlignment)[keyof typeof ParticleAlignment];

/**
 * one particle system. positions are in the emitter's frame, the instance row's transform: the particle's
 * world position is that transform applied to its local one. Unity's gravity always points down the world's
 * y, so it is given in the world frame
 */
export interface ParticleSystemInfo {
	/**
	 * what each particle draws. every mode but {@link ParticleRenderMode.Mesh} draws a unit quad in its xy plane
	 * (the chain draw's geometry), turned as the mode says
	 */
	renderMode: ParticleRenderMode;
	/** how {@link ParticleRenderMode.Stretched} quads lengthen; `null` for other modes */
	stretch: ParticleStretchInfo | null;
	/**
	 * the smallest and largest a quad may be on screen, as fractions of the viewport's width at its depth: its
	 * larger side is held between them, scaling both (a stretched quad's length keeps its own). `null` for
	 * {@link ParticleRenderMode.Mesh}
	 */
	screenSize: { min: number; max: number } | null;
	/**
	 * whether the emitter matrix's scale sizes the particles as well as moving them; otherwise they keep their
	 * own size (Unity's `Shape` scaling mode). the packer resolves the other modes into the matrix itself
	 */
	sizedByScale: boolean;
	/** seconds per loop; emission stops after one when not {@link looping} */
	duration: number;
	looping: boolean;
	/** seconds before the first emission, a constant or two (one drawn per play) */
	startDelay: MinMaxCurveInfo;
	/** the most particles alive at once */
	maxParticles: number;
	/**
	 * the most particles one longest lifetime of emission holds, ignoring {@link maxParticles}. above the cap,
	 * which particles live depends on the emissions the cap turned away before
	 */
	emissionBound: number;
	/** the system's time scale */
	simulationSpeed: number;
	/** seconds; read at the emission time over the duration */
	startLifetime: MinMaxCurveInfo;
	/** each particle's colour, read at the emission's place in its loop; it multiplies the mesh's vertex colours */
	startColor: MinMaxGradientInfo;
	/** a multiplier of the start colour, read at each particle's age over its lifetime; `null` without */
	colorOverLifetime: MinMaxGradientInfo | null;
	/** x, y and z scale of the mesh, m */
	startSize: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** Euler angles about x, y and z, radians */
	startRotation: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** particles per second; a constant or two */
	rate: MinMaxCurveInfo;
	bursts: ParticleBurstInfo[];
	/** `null` emits every particle at the emitter's origin, along +z */
	shape: ParticleShapeInfo | null;
	/** how the particles move from where the shape starts them */
	motion: ParticleMotionInfo;
	/** a multiplier of the start size over each particle's lifetime, per axis; `null` without */
	sizeOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	/**
	 * angular velocity about x, y and z, radians per second, read at each particle's age over its lifetime; the
	 * angle is its integral over the age. `null` without
	 */
	rotationOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	alignment: ParticleAlignment;
	/**
	 * the mesh's offset from the particle's position, in units of its size; for mesh particles the packer has
	 * already multiplied the renderer's pivot by the mesh's size
	 */
	pivot: Vec3;
	/**
	 * the relative chance of each of the system's meshes (up to four); each particle draws one. a renderer with
	 * several meshes is one entry per mesh, differing only in {@link mesh}, each drawing its own particles.
	 * quads are one mesh, `[1]`
	 */
	meshWeights: number[];
	/** which of {@link meshWeights} the draw naming this entry shows */
	mesh: number;
	/**
	 * particles outlive their lifetime until newer ones replace them (Unity's ring buffer); `null` when they
	 * die at the end of it
	 */
	ringBuffer: ParticleRingBufferInfo | null;
	/** a flipbook the particles step through (Unity's `TextureSheetAnimationModule`); `null` without */
	textureSheet: ParticleTextureSheetInfo | null;
}

/** how a {@link ParticleSystemInfo}'s particles move: freely, or along a path */
export type ParticleMotionInfo = ParticleFreeMotionInfo | ParticleSplineInfo;

/** an ordinary system's motion: launched along the shape's direction, then moved by its modules */
export interface ParticleFreeMotionInfo {
	kind: 'free';
	/** m/s along the shape's start direction */
	startSpeed: MinMaxCurveInfo;
	/** times {@link GRAVITY} */
	gravityModifier: MinMaxCurveInfo;
	/** extra velocity over each particle's lifetime (Unity's `VelocityModule`); `null` without */
	velocity: ParticleVelocityInfo | null;
	/** what Unity's `ClampVelocityModule` does to the particles' speed; `null` without */
	clamp: ParticleClampInfo | null;
}

/**
 * Unity's `ClampVelocityModule`: drag slowing each particle's start velocity and its fall, or (with a
 * `dampen`) a speed limit each particle's speed is pulled down to. the packer turns a system using both into
 * a stand-in
 */
export type ParticleClampInfo = ParticleDragInfo | ParticleSpeedLimitInfo;

/** one cubic Bézier segment of a {@link ParticleSplineInfo}, in the emitter's frame */
export interface SplineSegmentInfo {
	/** the start point, its two control points and the end point */
	points: [Vec3, Vec3, Vec3, Vec3];
	/** m along the path this segment takes up, the length the game gives it */
	length: number;
}

/**
 * a path of cubic Bézier segments laid end to end (Beyond's `HGSplineMovingObjects`). a particle `d` metres
 * along it lies in the segment its distance falls in, at the Bézier parameter `(d − segment start) / length`,
 * which is linear in distance only for evenly spaced control points. it dies once `d` passes the last
 * segment's end, even within its lifetime
 */
export interface ParticleSplineInfo {
	kind: 'spline';
	segments: SplineSegmentInfo[];
	/** m/s along the path, read at the particle's age over its lifetime; the distance is its integral */
	speed: MinMaxCurveInfo;
}

/** how a ring-buffered particle carries on past its lifetime */
export interface ParticleRingBufferInfo {
	/** `false` holds it at its end state; `true` replays the part of its lifetime in {@link loopRange} */
	loop: boolean;
	/** the replayed span, as fractions of the lifetime */
	loopRange: [number, number];
}

/** {@link ParticleTextureSheetInfo.row} values besides a fixed row */
export const SheetRow = {
	/** a random row per particle */
	Random: -1,
	/** the row of the particle's mesh, {@link ParticleSystemInfo.mesh} */
	MeshIndex: -2,
} as const;

/**
 * a grid of tiles the particle mesh's UVs are remapped into, one tile at a time. tiles count left to right,
 * then top to bottom, from the texture's top-left. tile `i` maps a UV `uv` to `(uv + (i mod x, y − 1 −
 * floor(i / x))) / (x, y)`, UV (0, 0) being the texture's bottom-left as in Unity
 */
export interface ParticleTextureSheetInfo {
	/** tiles across and down, 1–64 each */
	tiles: [number, number];
	/**
	 * `null` steps through the whole sheet; a row number steps along that row alone, or a {@link SheetRow} value
	 * picks the row per particle
	 */
	row: number | null;
	/**
	 * the frame, as a fraction of the frames: read at the particle's age over its lifetime, repeated
	 * {@link cycles} times. `null` when frames advance by {@link fps} instead
	 */
	frameOverTime: MinMaxCurveInfo | null;
	/** frames per second, when {@link frameOverTime} is `null` */
	fps: number;
	/** added to the frame, as a fraction of the frames; read at the emission's place in its loop */
	startFrame: MinMaxCurveInfo;
	cycles: number;
	/** which UV sets take the tile: bit 0 for UV0, bit 1 for UV1 */
	uvChannels: number;
}

/** how strongly the air slows a particle: its deceleration is {@link amount} times the factors chosen */
export interface ParticleDragInfo {
	kind: 'drag';
	/** a constant or two */
	amount: MinMaxCurveInfo;
	/** times the particle's cross-section, π (size / 2)² */
	bySize: boolean;
	/** times its speed squared rather than its speed */
	byVelocity: boolean;
}

/**
 * a limit on a particle's whole speed, its velocity over lifetime included. while the speed exceeds the
 * limit, each step pulls it {@link dampen} of the way down to the limit per 1/30 s, taking the excess from the
 * particle's own velocity: with speed `s`, limit `L` and a step of `t` seconds, the speed becomes `s + (L −
 * s)(1 − (1 − dampen)^(30 t))` along the same direction
 */
export interface ParticleSpeedLimitInfo {
	kind: 'limit';
	/** m/s, read at the particle's age over its lifetime */
	limit: MinMaxCurveInfo;
	/** the fraction of the excess removed per 1/30 s, above 0 */
	dampen: number;
}

/** Unity's `VelocityModule`; all but {@link linear} are constant (or two-constant) */
export interface ParticleVelocityInfo {
	/** m/s along x, y and z, read at the particle's age over its lifetime */
	linear: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** whether {@link linear} is in world axes rather than the emitter's */
	linearInWorld: boolean;
	/** radians per second about the emitter's x, y and z axes, through {@link orbitalOffset} */
	orbital: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	orbitalOffset: Vec3;
	/** m/s away from {@link orbitalOffset} */
	radial: MinMaxCurveInfo;
	/** scales every velocity */
	speedModifier: MinMaxCurveInfo;
}
