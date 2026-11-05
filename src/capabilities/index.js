import { DEVTO_STATS_TOTALS_CAPABILITY, isDevtoStatsInstalled, runDevtoStatsTotals } from './devto-stats-totals.js';
import { createCapabilityRegistry } from './registry.js';

export const localCapabilityRegistry = createCapabilityRegistry([{
    ...DEVTO_STATS_TOTALS_CAPABILITY,
    access: 'read only',
    requirement: 'Python 3',
    isInstalled: isDevtoStatsInstalled,
    run: runDevtoStatsTotals,
}]);

export function listLocalCapabilities(companyRoot) {
    return localCapabilityRegistry.listInstalled(companyRoot);
}
