import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPool} from '../lib/db.js';

test('idle connection errors are handled without logging connection details', async () => {
  const pool = createPool('postgresql://synthetic:synthetic@localhost/synthetic_test');
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args);
  try {
    const error = Object.assign(new Error('sensitive connection details'), {code: 'ETIMEDOUT'});
    assert.doesNotThrow(() => pool.emit('error', error, {password: 'sensitive'}));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], ['Database idle connection lost; the pool discarded it.']);
  } finally {
    console.error = original;
    await pool.end();
  }
});
