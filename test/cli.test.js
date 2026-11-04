import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { parseAgentAssignmentOptions, parseAgentBetsOptions, parseAgentLoginOptions, parseAgentStatusOptions, parseAgentTaskCreateOptions, parseAgentTaskEditOptions, parseAgentTasksOptions, parseEnrollOptions, parseTaskId, parseTasksOptions, readHiddenCode, run } from '../src/cli.js';
import { formatAssignee } from '../src/client.js';

test('task assignee labels distinguish people and agents and sanitize terminal controls', () => {
    assert.equal(formatAssignee(null), 'sin asignar');
    assert.equal(formatAssignee({ type: 'user', name: 'Ana' }), 'Persona: Ana');
    assert.equal(formatAssignee({ type: 'agent', name: 'Vera\u001B[31m' }), 'Agente: Vera [31m');
});

test('enrollment options use the current directory without a path option', () => {
    assert.deepEqual(parseEnrollOptions([
        '--server=https://mycompanies.example',
        '--allow-insecure-localhost',
    ]), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: true,
    });
    assert.deepEqual(parseEnrollOptions(['--server=https://mycompanies.example']), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: false,
    });
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example', '--workspace-path=/work']), /Opción desconocida/);
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example', '--token=secret']), /Opción desconocida/);
});

test('agent login requires a server and supports explicit loopback HTTP only', () => {
    assert.deepEqual(parseAgentLoginOptions(['--server=https://mycompanies.example']), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: false,
    });
    assert.deepEqual(parseAgentLoginOptions(['--server=http://127.0.0.1:8150', '--allow-insecure-localhost']), {
        server: 'http://127.0.0.1:8150',
        allowInsecureLocalhost: true,
    });
    assert.throws(() => parseAgentLoginOptions([]), /Falta el servidor/);
    assert.throws(() => parseAgentLoginOptions(['--server=https://example.com', '--token=secret']), /Opción desconocida/);
});

test('agent task listing accepts a single positive cursor', () => {
    assert.deepEqual(parseAgentTasksOptions([]), { afterId: null });
    assert.deepEqual(parseAgentTasksOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentTasksOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentTasksOptions(['--after=25', '--after=50']), /Opción desconocida/);
});

test('agent bet listing accepts a single positive cursor', () => {
    assert.deepEqual(parseAgentBetsOptions([]), { afterId: null });
    assert.deepEqual(parseAgentBetsOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentBetsOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentBetsOptions(['--other']), /Opción desconocida/);
});

test('agent status command requires a task ID and supported target status', () => {
    assert.deepEqual(parseAgentStatusOptions(['26', 'in_progress']), { taskId: 26, status: 'in_progress' });
    assert.deepEqual(parseAgentStatusOptions(['26', 'completed']), { taskId: 26, status: 'completed' });
    assert.throws(() => parseAgentStatusOptions(['26']), /Uso:/);
    assert.throws(() => parseAgentStatusOptions(['26', 'unknown']), /estado no es válido/);
});

test('agent task creation requires an idempotency UUID and rejects unknown options', () => {
    const idempotencyKey = '94030b4e-0580-42f6-96d6-cb2b2fe7b457';
    assert.deepEqual(parseAgentTaskCreateOptions([
        '--title=Revisar informe',
        '--priority=high',
        `--idempotency-key=${idempotencyKey}`,
        '--workspace-id=12',
    ]), {
        idempotencyKey,
        task: { title: 'Revisar informe', priority: 'high', workspace_id: 12 },
    });
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar', '--idempotency-key=bad']), /UUID/);
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar']), /idempotency-key/);
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar', '--idempotency-key=' + idempotencyKey, '--command=rm']), /Opción desconocida/);
});

test('agent assignment command accepts a positive Agent ID or explicit unassignment', () => {
    assert.deepEqual(parseAgentAssignmentOptions(['27', '13']), { taskId: 27, assigneeAgentId: 13 });
    assert.deepEqual(parseAgentAssignmentOptions(['27', 'none']), { taskId: 27, assigneeAgentId: null });
    assert.throws(() => parseAgentAssignmentOptions(['27', '0']), /entero positivo/);
    assert.throws(() => parseAgentAssignmentOptions(['27']), /Uso:/);
});

test('agent task edit only accepts editable detail fields and requires at least one', () => {
    assert.deepEqual(parseAgentTaskEditOptions(['27', '--title=Actualizar métricas', '--priority=high']), {
        taskId: 27,
        changes: { title: 'Actualizar métricas', priority: 'high' },
    });
    assert.deepEqual(parseAgentTaskEditOptions(['27', '--due-date=none']), {
        taskId: 27,
        changes: { due_date: null },
    });
    assert.throws(() => parseAgentTaskEditOptions(['27']), /al menos un campo/);
    assert.throws(() => parseAgentTaskEditOptions(['27', '--status=completed']), /Opción desconocida/);
});

test('the executable command is named mycompany and help uses that name', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageConfiguration = JSON.parse(await readFile(packagePath, 'utf8'));
    const output = { value: '', write(chunk) { this.value += chunk; } };

    assert.deepEqual(packageConfiguration.bin, { mycompany: './src/cli.js' });
    assert.equal(await run(['help'], { stdout: output }), 0);
    assert.match(output.value, /mycompany heartbeat/);
    assert.match(output.value, /mycompany init/);
    assert.match(output.value, /mycompany work/);
    assert.match(output.value, /mycompany tasks/);
    assert.match(output.value, /mycompany task ID/);
    assert.match(output.value, /mycompany agent login/);
    assert.match(output.value, /mycompany agent me/);
    assert.match(output.value, /mycompany agent tasks/);
    assert.match(output.value, /mycompany agent bets/);
    assert.match(output.value, /mycompany agent bet ID/);
    assert.match(output.value, /mycompany agent task ID/);
    assert.match(output.value, /mycompany agent task status ID ESTADO/);
    assert.match(output.value, /mycompany agent task create/);
    assert.match(output.value, /mycompany agent task assign ID/);
    assert.match(output.value, /mycompany agent task edit ID/);
    assert.match(output.value, /no hay sincronización automática/);
    assert.match(output.value, /no se crea una carpeta por Workspace/);
    assert.match(output.value, /no conecta con el servidor/);
    assert.match(output.value, /No reclama, modifica, marca como terminadas ni ejecuta/);
    assert.match(output.value, /No revoca el Runner en MyCompanies/);
    assert.doesNotMatch(output.value, /company-runner/);
});

test('init prepares the selected company root without Runner enrollment', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-cli-test-'));
    try {
        const output = { value: '', write(chunk) { this.value += chunk; } };
        assert.equal(await run(['init'], { stdout: output }, directory), 0);
        assert.match(output.value, /8 archivos creados/);
        assert.equal((await stat(path.join(directory, 'AGENTS.md'))).isFile(), true);
        assert.equal((await stat(path.join(directory, 'CLAUDE.md'))).isFile(), true);

        output.value = '';
        await run(['init'], { stdout: output }, directory);
        assert.match(output.value, /0 archivos creados/);
        assert.match(output.value, /sin cambios/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('task detail accepts only a positive numeric task ID', () => {
    assert.equal(parseTaskId('42'), 42);
    assert.throws(() => parseTaskId('0'), /entero positivo/);
    assert.throws(() => parseTaskId('4abc'), /entero positivo/);
    assert.throws(() => parseTaskId('9007199254740992'), /entero positivo/);
});

test('task listing accepts one positive after cursor', () => {
    assert.deepEqual(parseTasksOptions([]), { afterId: null });
    assert.deepEqual(parseTasksOptions(['--after=100']), { afterId: 100 });
    assert.throws(() => parseTasksOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseTasksOptions(['--all']), /Opción desconocida/);
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
