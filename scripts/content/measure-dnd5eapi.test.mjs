import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, rasterBlock, API } from './measure-dnd5eapi.mjs';

// A stub of the two endpoint shapes that matter: the monster list, and the
// per-monster detail whose optional `image` field is the whole question.
function stubFetch() {
  const detail = {
    goblin: { index: 'goblin', name: 'Goblin', image: '/api/images/monsters/goblin.png' },
    aboleth: { index: 'aboleth', name: 'Aboleth', image: '/api/images/monsters/aboleth.png' },
    bandit: { index: 'bandit', name: 'Bandit' }, // no image — the common case
  };
  return async url => {
    if (url.endsWith('/api/2014/monsters')) {
      return {
        ok: true,
        json: async () => ({
          results: Object.values(detail).map(d => ({ index: d.index, name: d.name })),
        }),
      };
    }
    const index = url.split('/').pop();
    if (detail[index]) return { ok: true, json: async () => detail[index] };
    return { ok: false, status: 404 };
  };
}

test('measure counts monsters with a real image field, not just monsters', async () => {
  const report = await measure({ fetchFn: stubFetch() });
  assert.equal(report.total, 3);
  assert.equal(report.withImage, 2);
  assert.deepEqual(
    report.hits.map(h => h.name),
    ['Goblin', 'Aboleth'],
  );
  assert.deepEqual(report.errors, []);
});

test('a failing detail fetch is counted, not fatal', async () => {
  const base = stubFetch();
  const flaky = async url => (url.endsWith('/goblin') ? { ok: false, status: 500 } : base(url));
  const report = await measure({ fetchFn: flaky });
  assert.equal(report.withImage, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /goblin/);
});

test('rasterBlock emits the disabled map fragment, keyed by creature name', () => {
  const block = rasterBlock([{ name: 'Goblin', image: '/api/images/monsters/goblin.png' }]);
  assert.equal(block.enabled, false, 'measured is not the same as enabled — a human flips this');
  assert.equal(block.byName.Goblin.src, `${API}/api/images/monsters/goblin.png`);
});
