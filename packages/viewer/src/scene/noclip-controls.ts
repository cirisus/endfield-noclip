/**
 * free-flight camera controls: WASD to move, mouse look under pointer lock (or drag), E/R or Space up, Q/F or
 * C/Shift down, right mouse to boost, Alt to creep, wheel to zoom, Ctrl+wheel to change the base speed.
 *
 * @module
 */

import type { Camera, Vec3 } from './camera.ts';

const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.001;
/** velocity smoothing time constant, s */
const SMOOTHING = 0.08;
const BOOST = 5;
const CREEP = 0.2;
const MIN_FOV = (20 * Math.PI) / 180;
const MAX_FOV = (100 * Math.PI) / 180;

/** a camera pose to fly to */
export interface CameraPose {
	position: Vec3;
	yaw: number;
	pitch: number;
}

interface Flight {
	from: CameraPose;
	to: CameraPose;
	start: number;
	duration: number;
	arc: number;
}

const isTyping = (target: EventTarget | null): boolean =>
	target instanceof HTMLInputElement ||
	target instanceof HTMLTextAreaElement ||
	target instanceof HTMLSelectElement;

const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** keyboard/mouse flight for a {@link Camera} */
export class NoclipControls {
	/** base speed, m/s */
	speed = 40;
	/** speed applied in the last update, m/s */
	effectiveSpeed = 0;

	#camera: Camera;
	#element: HTMLElement;
	#keys = new Set<string>();
	#velocity: Vec3 = [0, 0, 0];
	#flight: Flight | null = null;
	#dragging = false;
	#boosting = false;
	#changed = false;
	#abort = new AbortController();

	/**
	 * @param camera the camera to drive
	 * @param element receives clicks (pointer lock) and wheel events
	 */
	constructor(camera: Camera, element: HTMLElement) {
		this.#camera = camera;
		this.#element = element;
		const signal = this.#abort.signal;

		window.addEventListener(
			'keydown',
			(event) => {
				if (isTyping(event.target) || event.metaKey || event.ctrlKey) {
					return;
				}
				this.#keys.add(event.code);
				if (event.code === 'Space' || event.code.startsWith('Arrow')) {
					event.preventDefault();
				}
			},
			{ signal },
		);
		window.addEventListener('keyup', (event) => this.#keys.delete(event.code), { signal });
		const release = () => {
			this.#keys.clear();
			this.#boosting = false;
			this.#dragging = false;
		};
		window.addEventListener('blur', release, { signal });
		element.addEventListener('pointercancel', release, { signal });
		document.addEventListener(
			'pointerlockchange',
			() => {
				if (document.pointerLockElement !== element) {
					release();
				}
			},
			{ signal },
		);
		// Mouse events retain individual button changes when left and right are held together.
		element.addEventListener(
			'mousedown',
			(event) => {
				if (event.button === 2) {
					this.#boosting = true;
				}
			},
			{ signal },
		);
		window.addEventListener(
			'mouseup',
			(event) => {
				if (event.button === 0) {
					this.#dragging = false;
				}
				if (event.button === 2) {
					this.#boosting = false;
				}
			},
			{ signal },
		);

		element.addEventListener(
			'pointerdown',
			(event) => {
				if (event.button !== 0) {
					return;
				}
				this.#dragging = true;
				element.setPointerCapture(event.pointerId);
				if (document.pointerLockElement !== element) {
					// pointer lock may be refused (e.g. right after leaving it); dragging still works then
					element.requestPointerLock()?.catch(() => {});
				}
			},
			{ signal },
		);
		window.addEventListener(
			'pointerup',
			(event) => {
				if (event.button === 0) {
					this.#dragging = false;
				}
			},
			{ signal },
		);
		element.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
		element.addEventListener(
			'pointermove',
			(event) => {
				if (document.pointerLockElement === element || this.#dragging) {
					this.#look(event.movementX, event.movementY);
				}
			},
			{ signal },
		);
		element.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				const pixels =
					event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
				if (event.ctrlKey) {
					this.speed = Math.min(5000, Math.max(0.5, this.speed * 1.15 ** (-pixels / 100)));
				} else {
					const fov = Math.min(
						MAX_FOV,
						Math.max(MIN_FOV, 2 * Math.atan(Math.tan(camera.fovY / 2) * 1.15 ** (pixels / 100))),
					);
					this.#changed ||= fov !== camera.fovY;
					camera.fovY = fov;
				}
			},
			{ signal, passive: false },
		);
	}

	#look(dx: number, dy: number): void {
		const camera = this.#camera;
		camera.yaw = wrapAngle(camera.yaw + dx * LOOK_SENSITIVITY);
		camera.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, camera.pitch - dy * LOOK_SENSITIVITY));
		this.#flight = null;
		this.#changed = true;
	}

	/**
	 * flies the camera to a pose along an arc.
	 *
	 * @param pose target pose
	 */
	flyTo(pose: CameraPose): void {
		const camera = this.#camera;
		const from: CameraPose = { position: [...camera.position], yaw: camera.yaw, pitch: camera.pitch };
		const distance = Math.hypot(
			pose.position[0] - from.position[0],
			pose.position[1] - from.position[1],
			pose.position[2] - from.position[2],
		);
		this.#flight = {
			from,
			to: pose,
			start: performance.now(),
			duration: Math.min(3000, 900 + distance * 0.6),
			arc: Math.min(distance * 0.2, 600),
		};
		this.#velocity = [0, 0, 0];
	}

	/**
	 * @param dt seconds since the last update
	 * @returns whether the camera moved
	 */
	update(dt: number): boolean {
		const camera = this.#camera;
		let moved = this.#changed;
		this.#changed = false;

		const flight = this.#flight;
		if (flight !== null) {
			const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
			const s = smootherstep(t);
			for (let i = 0; i < 3; i++) {
				camera.position[i] = flight.from.position[i] + (flight.to.position[i] - flight.from.position[i]) * s;
			}
			camera.position[1] += flight.arc * Math.sin(Math.PI * s);
			camera.yaw = flight.from.yaw + wrapAngle(flight.to.yaw - flight.from.yaw) * s;
			camera.pitch = flight.from.pitch + (flight.to.pitch - flight.from.pitch) * s;
			if (t >= 1) {
				this.#flight = null;
			}
			return true;
		}

		const key = (...codes: string[]): number => (codes.some((code) => this.#keys.has(code)) ? 1 : 0);
		const forward = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown');
		const strafe = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');
		const lift =
			key('KeyE', 'KeyR', 'Space', 'PageUp') -
			key('KeyQ', 'KeyF', 'KeyC', 'PageDown', 'ShiftLeft', 'ShiftRight');

		let speed = this.speed;
		if (this.#boosting) {
			speed *= BOOST;
		}
		if (this.#keys.has('AltLeft') || this.#keys.has('AltRight')) {
			speed *= CREEP;
		}
		this.effectiveSpeed = speed;

		const f = camera.forward();
		const r = camera.right();
		const target: Vec3 = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			target[i] = (f[i] * forward + r[i] * strafe) * speed;
		}
		target[1] += lift * speed;
		const blend = 1 - Math.exp(-dt / SMOOTHING);
		for (let i = 0; i < 3; i++) {
			this.#velocity[i] += (target[i] - this.#velocity[i]) * blend;
			if (Math.abs(this.#velocity[i]) < 1e-3 && target[i] === 0) {
				this.#velocity[i] = 0;
			}
			if (this.#velocity[i] !== 0) {
				camera.position[i] += this.#velocity[i] * dt;
				moved = true;
			}
		}
		return moved;
	}

	/** removes the listeners */
	destroy(): void {
		this.#abort.abort();
		if (document.pointerLockElement === this.#element) {
			document.exitPointerLock();
		}
	}
}
