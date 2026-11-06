import type { ConditionalSetInfo, RuleReference, RuleText, StatesInfo } from './states.ts';

/**
 * @param rule a control's rule
 * @param name names a reference; defaults to its own text
 * @returns the rule as one string
 */
export const ruleText = (
	rule: RuleText,
	name: (reference: RuleReference) => string = (reference) => reference.text,
): string => rule.map((part) => (typeof part === 'string' ? part : name(part))).join('');

/**
 * @param states exported scene controls
 * @param picks values the user picked, by control id; a pick on a derived control overrides its formula
 * @returns every control's value: picks, then the defaults of controls only the user sets, then derived
 *   controls evaluated in their stored order
 */
export const resolveSceneValues = (
	states: Pick<StatesInfo, 'controls' | 'conditionalSets'>,
	picks: Readonly<Record<string, number>>,
): Record<string, number> => {
	const values: Record<string, number> = {};
	for (const control of states.controls) {
		if (control.derived === null) {
			values[control.id] = picks[control.id] ?? control.default;
		}
	}
	for (const control of states.controls) {
		if (control.derived !== null) {
			const formula = states.conditionalSets[control.derived];
			values[control.id] =
				picks[control.id] ?? Number(formula !== undefined && conditionVisible(formula, values));
		}
	}
	return values;
};

/**
 * @param condition alternatives of required control values
 * @param values selected values, including defaults
 * @returns whether any complete alternative is satisfied; unknown controls fail closed
 */
export const conditionVisible = (
	condition: ConditionalSetInfo,
	values: Readonly<Record<string, number>>,
): boolean =>
	condition.alternatives.some((requirements) =>
		requirements.every(({ control, mask }) => {
			const value = values[control];
			return Number.isInteger(value) && value >= 0 && value < 32 && ((mask >>> value) & 1) !== 0;
		}),
	);

/**
 * @param states exported scene controls
 * @param values every control's value (from {@link resolveSceneValues}), plus stream-area values
 * @returns per conditional set, whether the values satisfy it
 */
export const conditionResults = (states: StatesInfo, values: Readonly<Record<string, number>>): boolean[] =>
	states.conditionalSets.map((condition) => conditionVisible(condition, values));

/**
 * every level of a package shows at once, so a group's level tag doesn't decide whether it shows
 *
 * @param states exported scene controls
 * @param conditions per conditional set, whether it holds (from {@link conditionResults})
 * @returns per visibility group, whether its content shows: loaded by the current scene values
 */
export const groupsShown = (states: StatesInfo, conditions: readonly boolean[]): boolean[] =>
	states.groups.map(({ condition }) => condition === null || (conditions[condition] ?? false));
