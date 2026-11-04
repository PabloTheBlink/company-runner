import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseEnrollOptions, readHiddenCode } from '../src/cli.js';

test('enrollment options require server and workspace and reject unknown arguments', () => {
    assert.deepEqual(parseEnrollOptions([
        '--server=https://mycompanies.example',
        '--workspace-path=/work/company',
        '--allow-insecure-localhost',
    ]), {
        server: 'https://mycompanies.example',
        workspacePath: '/work/company',
        allowInsecureLocalhost: true,
    });
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example']), /Faltan opciones/);
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example', '--workspace-path=/work', '--token=secret']), /Opción desconocida/);
});

test('enrollment code input disables terminal echo and restores the prior mode', async () => {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.modes = [];
    stdin.setRawMode = (mode) => stdin.modes.push(mode);
    stdin.resume = () => {};
    stdin.pause = () => {};
    const output = { contents: '', write(value) { this.contents += value; } };

    const pendingCode = readHiddenCode(stdin, output);
    stdin.emit('data', Buffer.from(`${'C'.repeat(64)}\r`));

    assert.equal(await pendingCode, 'C'.repeat(64));
    assert.deepEqual(stdin.modes, [true, false]);
    assert.equal(output.contents.includes('C'.repeat(64)), false);
});

test('enrollment code input refuses non-interactive stdin', async () => {
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    assert.rejects(readHiddenCode(stdin, { write() {} }), /terminal interactivo/);
});
