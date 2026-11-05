import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRegistry } from '../src/capabilities/registry.js';

test('capability registry lists only adapters installed in the selected company root', async () => {
    const registry = createCapabilityRegistry([
        {
            name: 'example.read',
            version: '1.0.0',
            access: 'read only',
            requirement: 'Example tool',
            isInstalled: async (root) => root === '/company-a',
            run: async () => ({ value: 1 }),
            maxRuntimeMs: 1000,
            validateParameters: () => true,
            validateResult: () => true,
            summarize: () => ({}),
        },
        {
            name: 'example.write',
            version: '1.0.0',
            access: 'write',
            requirement: 'Example tool',
            isInstalled: async () => false,
            run: async () => ({ value: 2 }),
            maxRuntimeMs: 1000,
            validateParameters: () => true,
            validateResult: () => true,
            summarize: () => ({}),
        },
    ]);

    assert.deepEqual(await registry.listInstalled('/company-a'), [{
        name: 'example.read',
        version: '1.0.0',
        access: 'read only',
        requirement: 'Example tool',
    }]);
    assert.equal(registry.get('example.read', '1.0.0').name, 'example.read');
    assert.equal(registry.get('example.read', '2.0.0'), null);
});

test('capability registry rejects duplicate identities and incomplete adapters', () => {
    const adapter = {
        name: 'example.read',
        version: '1.0.0',
        access: 'read only',
        requirement: 'Example tool',
        isInstalled: async () => true,
        run: async () => ({}),
        maxRuntimeMs: 1000,
        validateParameters: () => true,
        validateResult: () => true,
        summarize: () => ({}),
    };

    assert.throws(() => createCapabilityRegistry([adapter, adapter]), /identidad duplicada/);
    assert.throws(() => createCapabilityRegistry([{ ...adapter, run: undefined }]), /adaptador de capacidad no es válido/);
});

test('capability registry exposes only declared Agent tool metadata, never executable functions', async () => {
    const agentTool = {
        permission: 'automations.execute',
        description: 'Read local metrics.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        validateParameters: (parameters) => Object.keys(parameters).length === 0,
    };
    const adapter = {
        name: 'company.metrics.read', version: '1.0.0', access: 'solo lectura', requirement: 'Python',
        isInstalled: async () => true, run: async () => ({}), maxRuntimeMs: 1000,
        validateParameters: () => true, validateResult: () => true, summarize: () => ({}), agentTool,
    };
    const registry = createCapabilityRegistry([adapter]);

    assert.deepEqual(await registry.listInstalled('/company'), [{
        name: adapter.name,
        version: adapter.version,
        access: adapter.access,
        requirement: adapter.requirement,
        agent_tool: {
            permission: agentTool.permission,
            description: agentTool.description,
            parameters: agentTool.parameters,
        },
    }]);
    assert.equal(typeof registry.get(adapter.name, adapter.version).agentTool.validateParameters, 'function');
    assert.throws(() => createCapabilityRegistry([{ ...adapter, agentTool: { permission: 'automations.execute' } }]), /adaptador de capacidad no es válido/);
});
