import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('Taiga pack isolates renders, verifies languages and protects previous output', () => {
  const result = spawnSync('python3', [path.join(process.cwd(), 'tests/unit/taiga_pack_test.py')], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
