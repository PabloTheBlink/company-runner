import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runMicroappsTelemetry, MICROAPPS_TELEMETRY_CAPABILITY } from '../src/capabilities/microapps-telemetry.js';
import { listAgentCapabilities } from '../src/capabilities/index.js';

async function withCompanyWorkspace(runTest) {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-microapps-test-'));
    const scriptPath = path.join(companyRoot, 'automations', 'microapps', 'inspect_telemetry.py');
    const helperPath = path.join(companyRoot, 'automations', 'microapps', 'telemetry_summary.php');
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, '# test fixture; never executed\n');
    await writeFile(helperPath, '<?php // test fixture; never executed\n');

    try {
        await runTest(companyRoot);
    } finally {
        await rm(companyRoot, { recursive: true, force: true });
    }
}

const validOutput = JSON.stringify({
    source: 'Devetty app telemetry',
    app: 'ugc-deal-tracker',
    environment: 'local',
    period_days: 7,
    page_views: 102,
    sessions: 67,
    requests: 145,
    javascript_errors: 1,
    server_errors: 0,
    resolved_errors: 3,
});

test('Microapps telemetry capability invokes only the fixed local read operation and returns aggregates', async () => {
    await withCompanyWorkspace(async (companyRoot) => {
        let invocation;
        const result = await runMicroappsTelemetry({
            companyRoot,
            parameters: { app: 'ugc-deal-tracker', days: 7, environment: 'local' },
            execFileImplementation(executable, args, options, callback) {
                invocation = { executable, args, options };
                callback(null, validOutput, 'progress output is discarded');
            },
        });

        assert.deepEqual(result, JSON.parse(validOutput));
        assert.equal(invocation.executable, 'python3');
        assert.deepEqual(invocation.args, ['automations/microapps/inspect_telemetry.py', '--app', 'ugc-deal-tracker', '--days', '7', '--environment', 'local']);
        assert.equal(invocation.options.cwd, companyRoot);
        assert.equal(invocation.options.shell, false);
        assert.equal(invocation.options.timeout, MICROAPPS_TELEMETRY_CAPABILITY.maxRuntimeMs);
        assert.equal(invocation.options.env.PYTHONIOENCODING, 'utf-8');
        assert.equal(invocation.options.env.DEVTO_API_KEY, undefined);
    });
});

test('Microapps telemetry capability summarizes only aggregate fields for the Agent', () => {
    assert.deepEqual(MICROAPPS_TELEMETRY_CAPABILITY.agentTool.summarize(JSON.parse(validOutput)), {
        source: 'Devetty app telemetry',
        app: 'ugc-deal-tracker',
        environment: 'local',
        period_days: 7,
        page_views: 102,
        sessions: 67,
        requests: 145,
        javascript_errors: 1,
        server_errors: 0,
        resolved_errors: 3,
    });
});

test('Microapps telemetry is exposed only to Agents with the company automation grant', async () => {
    await withCompanyWorkspace(async (companyRoot) => {
        const task = { workspace_id: null };
        const ungranted = await listAgentCapabilities(companyRoot, { permissions: [] }, task);
        const granted = await listAgentCapabilities(companyRoot, {
            permissions: [{ name: 'automations.execute', scope: 'company' }],
        }, task);

        assert.equal(ungranted.some(({ name }) => name === MICROAPPS_TELEMETRY_CAPABILITY.name), false);
        const capability = granted.find(({ name }) => name === MICROAPPS_TELEMETRY_CAPABILITY.name);
        assert.equal(capability.permission, 'automations.execute');
        assert.equal(capability.validateResult(JSON.parse(validOutput)), true);
        assert.equal(capability.validateResult({ ...JSON.parse(validOutput), recent_errors: [{ message: 'private' }] }), false);
    });
});

test('Microapps telemetry capability rejects invalid input, unsafe output, oversized output and process errors', async () => {
    await withCompanyWorkspace(async (companyRoot) => {
        let invocationCount = 0;
        const execFileImplementation = (_executable, _args, _options, callback) => {
            invocationCount++;
            callback(null, validOutput, 'sensitive stderr');
        };

        await assert.rejects(runMicroappsTelemetry({
            companyRoot,
            parameters: { app: '../outside', days: 7 },
            execFileImplementation,
        }), /parámetros/);
        assert.equal(invocationCount, 0);

        let productionInvocation;
        const productionResult = await runMicroappsTelemetry({
            companyRoot,
            parameters: { app: 'ugc-deal-tracker', days: 7, environment: 'production' },
            execFileImplementation(_executable, args, _options, callback) {
                productionInvocation = args;
                callback(null, JSON.stringify({ ...JSON.parse(validOutput), environment: 'production' }), '');
            },
        });
        assert.equal(productionResult.environment, 'production');
        assert.deepEqual(productionInvocation.slice(-2), ['--environment', 'production']);

        await assert.rejects(runMicroappsTelemetry({
            companyRoot,
            parameters: { app: 'ugc-deal-tracker', days: 7, environment: 'local' },
            execFileImplementation(_executable, _args, _options, callback) {
                callback(null, JSON.stringify({ ...JSON.parse(validOutput), recent_errors: [{ message: 'private' }] }), '');
            },
        }), /respuesta.*no es válida/);

        await assert.rejects(runMicroappsTelemetry({
            companyRoot,
            parameters: { app: 'ugc-deal-tracker', days: 7, environment: 'local' },
            execFileImplementation(_executable, _args, _options, callback) {
                callback(new Error('secret process failure'), '', 'sensitive stderr');
            },
        }), (error) => !error.message.includes('secret') && error.message.includes('consulta de telemetría'));
    });
});
