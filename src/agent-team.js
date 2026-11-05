export async function startAgentDirectReports({
    identity,
    provider,
    includeCompanyContext = false,
    includeMemory = false,
    currentDirectory,
    companyRootPath,
    configStore,
    agentClient,
    command,
    scriptPath,
    statePathForAgent,
    startWorker,
}) {
    if (!hasCompanyPermission(identity, 'agents.permissions.manage')) return [];

    const reports = await listAllDirectReports(agentClient, currentDirectory);
    let localIdentities = await configStore.listAgentIdentitiesForDirectory(
        currentDirectory,
        String(identity.agent.id),
    );
    const started = [];

    for (const report of reports) {
        if (report.status !== 'active' || !hasPermission(report, 'tasks.read')) continue;

        if (!localIdentities.some((localIdentity) => localIdentity.id === report.id)) {
            if (!hasCompanyPermission(identity, 'agents.credentials.manage')) {
                started.push({ agent_id: report.id, agent_name: report.name, status: 'credential_missing' });
                continue;
            }

            try {
                await agentClient.issueCredential(report.id, `MyCompanies worker · ${report.name}`, currentDirectory);
                localIdentities = await configStore.listAgentIdentitiesForDirectory(
                    currentDirectory,
                    String(identity.agent.id),
                );
            } catch {
                started.push({ agent_id: report.id, agent_name: report.name, status: 'credential_unavailable' });
                continue;
            }
        }

        if (!localIdentities.some((localIdentity) => localIdentity.id === report.id)) {
            started.push({ agent_id: report.id, agent_name: report.name, status: 'credential_unavailable' });
            continue;
        }

        try {
            const childConfiguration = await configStore.loadAgentForDirectory(
                currentDirectory,
                String(report.id),
            );
            if (childConfiguration.company_id !== identity.company.id
                || childConfiguration.agent_id !== report.id
                || childConfiguration.company_root_path !== companyRootPath) {
                started.push({ agent_id: report.id, agent_name: report.name, status: 'identity_mismatch' });
                continue;
            }

            const childIncludesMemory = includeMemory && hasPermission(report, 'memory.read');
            const childArgs = [
                scriptPath,
                'agent',
                'service',
                `--provider=${provider}`,
                ...(includeCompanyContext ? ['--include-company-context'] : []),
                ...(childIncludesMemory ? ['--include-memory'] : []),
            ];
            const state = await startWorker({
                statePath: statePathForAgent(report.id),
                agentId: report.id,
                command,
                args: childArgs,
                cwd: companyRootPath,
                metadata: {
                    provider,
                    include_company_context: includeCompanyContext,
                    include_memory: childIncludesMemory,
                    agent_id: report.id,
                    agent_name: report.name,
                    company_id: identity.company.id,
                    company_name: identity.company.name,
                    team_agents: [],
                },
            });
            started.push({
                agent_id: report.id,
                agent_name: report.name,
                status: state.status,
            });
        } catch {
            started.push({ agent_id: report.id, agent_name: report.name, status: 'worker_start_failed' });
        }
    }

    return started;
}

async function listAllDirectReports(agentClient, currentDirectory) {
    const reports = [];
    let afterId = null;
    const cursors = new Set();

    while (true) {
        const page = await agentClient.listAgents(currentDirectory, afterId);
        reports.push(...page.agents);
        if (!page.has_more) return reports;
        if (!Number.isSafeInteger(page.next_after) || cursors.has(page.next_after)) {
            throw new Error('La API no devolvió una paginación válida de reportes directos.');
        }
        cursors.add(page.next_after);
        afterId = page.next_after;
    }
}

function hasCompanyPermission(identity, permissionName) {
    return Array.isArray(identity?.permissions)
        && identity.permissions.some((permission) => permission?.name === permissionName
            && permission.scope === 'company');
}

function hasPermission(agent, permissionName) {
    return Array.isArray(agent?.permissions)
        && agent.permissions.some((permission) => permission?.name === permissionName
            && (permission.scope === 'company' || /^workspace:\d+$/.test(permission.scope)));
}
