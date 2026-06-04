import type { Hint } from '../schema/action.ts';

/**
 * Expands `${name}` placeholders in a string from a parameter map. Throws when
 * a placeholder has no matching parameter so a typo in a story or action fails
 * loudly instead of silently leaving a literal `${url}` in a URL field.
 */
export function interpolate(
  template: string,
  parameters: Record<string, string>,
): string {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) {
      throw new Error(`Missing parameter "${name}" for template "${template}"`);
    }
    return value;
  });
}

/**
 * Returns a new Hint with `text` and `selector` interpolated against the
 * supplied parameter map. `role` and `position` are enums and pass through.
 */
export function interpolateHint(
  hint: Hint,
  parameters: Record<string, string>,
): Hint {
  return {
    ...hint,
    text: hint.text ? interpolate(hint.text, parameters) : hint.text,
    selector: hint.selector
      ? interpolate(hint.selector, parameters)
      : hint.selector,
  };
}
