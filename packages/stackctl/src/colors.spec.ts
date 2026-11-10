import { colord } from 'colord';
import { expect, test } from 'vitest';
import { FOCUS_COLOR, NEEDED_COLOR } from './colors.js';

test('NEEDED_COLOR is the focus color darkened, with the same hue', () => {
  expect(colord(NEEDED_COLOR).brightness()).toBeLessThan(colord(FOCUS_COLOR).brightness());
  // Within a couple of degrees: the darker color has fewer steps to round its hue to.
  expect(Math.abs(colord(NEEDED_COLOR).hue() - colord(FOCUS_COLOR).hue())).toBeLessThanOrEqual(2);
});
