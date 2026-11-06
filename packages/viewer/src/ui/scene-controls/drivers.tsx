import type {
	ControlDriver,
	DrivenControl,
	QuestRef,
	SceneControl,
} from '@endfield-noclip/package-format/states';

import type { Viewer } from '../../viewer/viewer.ts';
import { FlyButton } from '../controls.tsx';

/** @returns a quest by mission and name where known, else by id */
const questText = (quest: QuestRef): string => {
	if (quest.mission === null) {
		return quest.id;
	}
	if (quest.name === null) {
		return quest.mission;
	}
	return `${quest.mission}: ${quest.name}`;
};

/** @returns a driver in words: what it does to the control, and why */
const driverText = (driver: ControlDriver, control: DrivenControl): string => {
	let verb = 'Set';
	if (driver.value !== null && control.kind === 'script') {
		verb = driver.value === 1 ? 'Shown' : 'Hidden';
	} else if (driver.value !== null) {
		const label = control.values.find(({ value }) => value === driver.value)?.label ?? String(driver.value);
		verb = `Set to ${label}`;
	}
	switch (driver.kind) {
		case 'quest': {
			return `${verb} by quest progress: ${driver.quests.map(questText).join('; ')}`;
		}
		case 'switch': {
			return `${verb} when the player uses ${driver.template ?? 'an interactive'}`;
		}
		case 'area': {
			return `${verb} when the player enters an area (${Math.round(driver.radius)} m)`;
		}
		case 'script': {
			return `${verb} while its level script runs${driver.radius === null ? '' : ` (area ${Math.round(driver.radius)} m)`}`;
		}
		case 'level': {
			return `${verb} by ${driver.name ?? driver.levelId}, another level reusing the map`;
		}
		case 'server': {
			return `${verb} by script stages or server events`;
		}
		case 'event': {
			switch (driver.event) {
				case 'combat': {
					return `${verb} by a fight (${driver.type})`;
				}
				case 'dialog': {
					return `${verb} after a dialogue or cutscene (${driver.type})`;
				}
				case 'variable': {
					return `${verb} when a game variable changes (${driver.type})`;
				}
				case 'entity': {
					return `${verb} by an entity event (${driver.type})`;
				}
			}
		}
		case 'unknown': {
			return `${verb} by an unclassified event (${driver.type})`;
		}
	}
};

/**
 * what sets a control in game, with a button to fly to each place it starts from; nothing for controls
 * without drivers
 *
 * @param viewer the loaded scene
 * @param control a scene control
 */
export const Drivers = ({ viewer, control }: { viewer: Viewer; control: SceneControl }) => {
	if ((control.kind !== 'script' && control.kind !== 'waterLevel') || control.drivers.length === 0) {
		return null;
	}
	return (
		<ul className="drivers">
			{control.drivers.map((driver) => {
				const position = 'position' in driver ? driver.position : null;
				const radius = 'radius' in driver ? (driver.radius ?? 20) : 20;
				return (
					<li key={JSON.stringify(driver)}>
						{driverText(driver, control)}
						{position !== null && <FlyButton viewer={viewer} point={position} size={radius} back={1.5} />}
					</li>
				);
			})}
		</ul>
	);
};
