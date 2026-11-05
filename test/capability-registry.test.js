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
        },
        {
            name: 'example.write',
            version: '1.0.0',
            access: 'write',
            requirement: 'Example tool',
            isInstalled: async () => false,
            run: async () => ({ value: 2 }),
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
    };

    assert.throws(() => createCapabilityRegistry([adapter, adapter]), /identidad duplicada/);
    assert.throws(() => createCapabilityRegistry([{ ...adapter, run: undefined }]), /adaptador de capacidad no es válido/);
});
