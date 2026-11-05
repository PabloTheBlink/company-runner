import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('npm executable path survives package manifest normalization', () => {
    assert.equal(packageJson.bin.mycompany, 'src/cli.js');
});
