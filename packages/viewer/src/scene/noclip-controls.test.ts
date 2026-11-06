/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';

import { Camera } from './camera.ts';
import { NoclipControls } from './noclip-controls.ts';

class Element extends EventTarget {
	clientHeight = 800;
	setPointerCapture(): void {}
	requestPointerLock(): undefined {
		return undefined;
	}
}
class TypingElement {
	value = '';
}
const names = ['window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'];
const original = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
let win: EventTarget;
let doc: EventTarget & { pointerLockElement: Element | null };
let element: Element;
let camera: Camera;
let controls: NoclipControls;
const send = (target: EventTarget, type: string, fields: object = {}): Event => {
	const event = Object.assign(new Event(type, { cancelable: true }), fields);
	target.dispatchEvent(event);
	return event;
};
beforeEach(() => {
	win = new EventTarget();
	doc = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock: () => {} });
	element = new Element();
	Object.assign(globalThis, {
		window: win,
		document: doc,
		HTMLInputElement: TypingElement,
		HTMLTextAreaElement: TypingElement,
		HTMLSelectElement: TypingElement,
	});
	camera = new Camera();
	controls = new NoclipControls(camera, element as unknown as HTMLElement);
});
afterEach(() => {
	controls.destroy();
	for (let i = 0; i < names.length; i++) {
		const descriptor = original[i];
		if (descriptor) {
			Object.defineProperty(globalThis, names[i], descriptor);
		} else {
			Reflect.deleteProperty(globalThis, names[i]);
		}
	}
});

it('cancels a previous flight before an automatic camera cut', () => {
	controls.flyTo({ position: [100, 100, 100], yaw: 1, pitch: 0.5 });
	controls.cancelFlight();
	camera.position = [1, 2, 3];
	controls.update(0.016);
	assert.deepEqual(camera.position, [1, 2, 3]);
});

it('makes either shift key descend at base speed, while right mouse boosts held movement', () => {
	for (const code of ['ShiftLeft', 'ShiftRight']) {
		send(win, 'keydown', { code });
		const y = camera.position[1];
		controls.update(0.1);
		assert.ok(camera.position[1] < y);
		assert.equal(controls.effectiveSpeed, 40);
		send(win, 'keyup', { code });
	}
	send(win, 'keydown', { code: 'KeyW' });
	send(element, 'mousedown', { button: 2 });
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 200);
	send(win, 'mouseup', { button: 2 });
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 40);
});

it('releases held boost on blur, pointer cancellation or leaving pointer lock', () => {
	for (const [target, type] of [
		[win, 'blur'],
		[element, 'pointercancel'],
		[doc, 'pointerlockchange'],
	] as const) {
		send(element, 'mousedown', { button: 2 });
		controls.update(0.1);
		assert.equal(controls.effectiveSpeed, 200);
		send(target, type);
		controls.update(0.1);
		assert.equal(controls.effectiveSpeed, 40);
	}
	assert.equal(send(element, 'contextmenu').defaultPrevented, true);
});

it('zooms the lens, clamps both ends and invalidates an otherwise stationary view', () => {
	const fov = camera.fovY;
	send(element, 'wheel', { deltaY: -100, deltaMode: 0, ctrlKey: false });
	assert.ok(camera.fovY < fov);
	assert.equal(controls.speed, 40);
	assert.equal(controls.update(0.1), true);
	assert.equal(controls.update(0.1), false);
	for (const [deltaY, degrees] of [
		[-100000, (2 * Math.atan(24 / (2 * 250)) * 180) / Math.PI],
		[100000, 100],
	]) {
		send(element, 'wheel', { deltaY, deltaMode: 0, ctrlKey: false });
		assert.ok(Math.abs((camera.fovY * 180) / Math.PI - degrees) < 1e-9);
	}
	assert.deepEqual(camera.position, [0, 0, 0]);
});

it('uses Ctrl+wheel only for bounded movement speed, with wheel line units normalized', () => {
	const fov = camera.fovY;
	send(element, 'wheel', { deltaY: -100, deltaMode: 0, ctrlKey: true });
	assert.ok(controls.speed > 40);
	assert.equal(camera.fovY, fov);
	for (const [deltaY, speed] of [
		[-100000, 5000],
		[100000, 0.5],
	]) {
		send(element, 'wheel', { deltaY, deltaMode: 0, ctrlKey: true });
		assert.equal(controls.speed, speed);
	}
	send(element, 'wheel', { deltaY: 1, deltaMode: 1, ctrlKey: false });
	const lineFov = camera.fovY;
	camera.fovY = fov;
	send(element, 'wheel', { deltaY: 16, deltaMode: 0, ctrlKey: false });
	assert.equal(camera.fovY, lineFov);
});

it('keeps left-button drag look when the right button is released', () => {
	send(element, 'pointerdown', { button: 0, pointerId: 1 });
	send(element, 'mousedown', { button: 2 });
	send(win, 'mouseup', { button: 2 });
	send(element, 'pointermove', { movementX: 20, movementY: 0 });
	assert.ok(camera.yaw > 0);
	send(win, 'pointerup', { button: 0 });
	const yaw = camera.yaw;
	send(element, 'pointermove', { movementX: 20, movementY: 0 });
	assert.equal(camera.yaw, yaw);
});

it('ends drag look when the left button is released while right boost remains held', () => {
	send(element, 'pointerdown', { button: 0, pointerId: 1 });
	send(element, 'mousedown', { button: 2 });
	send(win, 'mouseup', { button: 0 });
	send(element, 'pointermove', { movementX: 20, movementY: 0 });
	assert.equal(camera.yaw, 0);
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 200);
	send(win, 'mouseup', { button: 2 });
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 40);
});

it('adapts ordinary flight to ground clearance without overwriting the stored speed trim', () => {
	controls.groundHeight = 1000;
	const sample = (height: number): number => {
		camera.position[1] = 1000 + height;
		controls.update(0.016);
		return controls.effectiveSpeed;
	};
	assert.equal(sample(-10), 10);
	assert.equal(sample(5), 10);
	assert.ok(sample(30) > 10 && sample(30) < sample(60));
	assert.equal(sample(100), 50);
	assert.equal(sample(10000), 50);
	assert.ok(Math.abs(sample(5.01) - sample(5)) < 0.001);
	assert.ok(Math.abs(sample(100) - sample(99.99)) < 0.001);
	controls.speed = 20;
	assert.equal(sample(5), 5);
	assert.equal(sample(100), 25);
	controls.speed = 5000;
	assert.equal(sample(5), 50);
	assert.equal(controls.speed, 5000);
	controls.groundHeight = null;
	controls.update(0.016);
	assert.equal(controls.effectiveSpeed, 5000);
});

it('slows while Tab is held in flight, takes priority over boost and restores on release', () => {
	doc.pointerLockElement = element;
	controls.groundHeight = 0;
	camera.position[1] = 100;
	send(win, 'keydown', { code: 'KeyW' });
	const regularZ = camera.position[2];
	controls.update(1);
	assert.ok(camera.position[2] - regularZ > 49);
	send(element, 'mousedown', { button: 2 });
	assert.equal(send(win, 'keydown', { code: 'Tab' }).defaultPrevented, true);
	const slowZ = camera.position[2];
	controls.update(1);
	assert.equal(controls.effectiveSpeed, 10);
	assert.ok(camera.position[2] - slowZ < 11);
	send(win, 'keyup', { code: 'Tab' });
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 250);
	send(win, 'mouseup', { button: 2 });
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 50);
	send(win, 'keydown', { code: 'Tab' });
	send(win, 'blur');
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 50);
});

it('preserves idle Tab navigation and ignores Tab in form fields', () => {
	assert.equal(send(win, 'keydown', { code: 'Tab' }).defaultPrevented, false);
	controls.update(0.1);
	assert.equal(controls.effectiveSpeed, 40);
	const input = new TypingElement();
	const event = new Event('keydown', { cancelable: true });
	Object.assign(event, { code: 'Tab' });
	Object.defineProperty(event, 'target', { value: input });
	doc.pointerLockElement = element;
	win.dispatchEvent(event);
	controls.update(0.1);
	assert.equal(event.defaultPrevented, false);
	assert.equal(controls.effectiveSpeed, 40);
});

it('keeps combined movement inside the adaptive speed cap', () => {
	controls.groundHeight = 0;
	camera.position[1] = 100;
	const before = [...camera.position];
	for (const code of ['KeyW', 'KeyD', 'Space']) {
		send(win, 'keydown', { code });
	}
	controls.update(1);
	const travelled = Math.hypot(...camera.position.map((value, i) => value - before[i]));
	assert.ok(travelled > 49 && travelled <= 50);
});
