import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPreference, writePreference } from '@/lib/editorPreferences';

test('cloud updates default to off and retain an existing explicit choice', () => {
  assert.equal(readPreference('cloudAutoSave'), false);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map([['open-screenshot-generator.cloud-auto-save', '1']]);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: () => {},
    },
  });
  try {
    assert.equal(readPreference('cloudAutoSave'), true);
    writePreference('cloudAutoSave', false);
    assert.equal(readPreference('cloudAutoSave'), false);
    assert.equal(storage.get('open-screenshot-generator.cloud-auto-save'), '0');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
