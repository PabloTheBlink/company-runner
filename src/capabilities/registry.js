const CAPABILITY_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/;
const CAPABILITY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function createCapabilityRegistry(adapters) {
    if (!Array.isArray(adapters)) {
        throw new Error('El registro de capacidades no es válido.');
    }

    const adapterByIdentity = new Map();
    for (const adapter of adapters) {
        if (adapter === null
            || typeof adapter !== 'object'
            || typeof adapter.name !== 'string'
            || !CAPABILITY_NAME_PATTERN.test(adapter.name)
            || typeof adapter.version !== 'string'
            || !CAPABILITY_VERSION_PATTERN.test(adapter.version)
            || typeof adapter.access !== 'string'
            || typeof adapter.requirement !== 'string'
            || typeof adapter.isInstalled !== 'function'
            || typeof adapter.run !== 'function'
            || !Number.isInteger(adapter.maxRuntimeMs)
            || adapter.maxRuntimeMs < 1
            || typeof adapter.validateParameters !== 'function'
            || typeof adapter.validateResult !== 'function'
            || typeof adapter.summarize !== 'function') {
            throw new Error('El adaptador de capacidad no es válido.');
        }

        const identity = `${adapter.name}@${adapter.version}`;
        if (adapterByIdentity.has(identity)) {
            throw new Error(`La identidad duplicada de capacidad ${identity} no está permitida.`);
        }

        adapterByIdentity.set(identity, Object.freeze({ ...adapter }));
    }

    return Object.freeze({
        get(name, version) {
            return adapterByIdentity.get(`${name}@${version}`) ?? null;
        },
        async listInstalled(companyRoot) {
            const installed = [];
            for (const adapter of adapterByIdentity.values()) {
                if (await adapter.isInstalled(companyRoot)) {
                    installed.push({
                        name: adapter.name,
                        version: adapter.version,
                        access: adapter.access,
                        requirement: adapter.requirement,
                    });
                }
            }

            return installed;
        },
    });
}
