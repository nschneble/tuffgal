import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interpolate, interpolateHint } from './interpolate.ts';

describe('interpolate', () => {
  it('expands a single placeholder', () => {
    assert.equal(interpolate('/users/${id}', { id: '42' }), '/users/42');
  });

  it('expands multiple placeholders', () => {
    assert.equal(interpolate('${a}-${b}', { a: 'x', b: 'y' }), 'x-y');
  });

  it('expands hyphen and dot parameter keys', () => {
    assert.equal(
      interpolate('${my-key}.${a.b}', { 'my-key': 'v', 'a.b': 'w' }),
      'v.w',
    );
  });

  it('throws loudly on a missing parameter rather than leaking the token', () => {
    assert.throws(
      () => interpolate('/x/${missing}', {}),
      /Missing parameter "missing"/,
    );
  });
});

describe('interpolateHint', () => {
  it('interpolates text and selector, passes role through untouched', () => {
    const hint = interpolateHint(
      { role: 'button', text: '${label}', selector: '#${id}' },
      { label: 'Save', id: 'btn' },
    );
    assert.equal(hint.role, 'button');
    assert.equal(hint.text, 'Save');
    assert.equal(hint.selector, '#btn');
  });

  it('leaves absent fields absent', () => {
    const hint = interpolateHint({ role: 'link' }, {});
    assert.equal(hint.text, undefined);
    assert.equal(hint.selector, undefined);
  });
});
