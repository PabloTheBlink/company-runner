import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../src/config.js';

async function withTemporaryConfig(runTest) {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompanies-runner-test-'));
    const store = new ConfigStore(path.join(directory, 'private', 'runner.json'));

    try {
        await runTest(store, directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('configuration is private, readable by the owner and removable', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const configuration = {
            server_url: 'https://mycompanies.example',
            runner_id: 7,
            workspace_path: directory,
            allow_insecure_localhost: false,
            api_token: 'private-token',
        };

        await store.saveNew(configuration);

        assert.deepEqual(await store.load(), configuration);
        assert.equal((await stat(path.join(store.registrationsDirectory, 'runner-7.json'))).mode & 0o777, 0o600);
        assert.equal((await stat(path.dirname(store.path))).mode & 0o777, 0o700);
        await assert.rejects(store.saveNew(configuration), /Ya existe una configuración Runner/);
        await store.forget(directory);
        await assert.rejects(store.load(), /No hay una configuración Runner/);
    });
});

test('agent credentials are stored separately with private permissions and selected by company folder', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const companyRoot = path.join(directory, 'company');
        const nestedProject = path.join(companyRoot, 'repo');
        await mkdir(nestedProject, { recursive: true });
        const agentConfiguration = {
            server_url: 'https://mycompanies.example',
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: false,
            api_token: 'A'.repeat(80),
        };

        await store.saveAgent(agentConfiguration);

        assert.deepEqual(await store.loadAgentForDirectory(nestedProject), agentConfiguration);
        assert.equal((await stat(path.join(store.agentsDirectory, 'agent-12.json'))).mode & 0o777, 0o600);
        assert.equal((await stat(store.agentsDirectory)).mode & 0o777, 0o700);
        await store.forgetAgent(nestedProject);
        await assert.rejects(store.loadAgentForDirectory(nestedProject), /No hay un agente configurado/);
    });
});

test('configuration load rejects group-readable files and symbolic links', async () => {
    await withTemporaryConfig(async (store, directory) => {
        await mkdir(path.dirname(store.path), { recursive: true });
        await writeFile(store.path, JSON.stringify({ runner_id: 7 }), { mode: 0o644 });
        await assert.rejects(store.load(), /permite acceso a otros usuarios/);

        const linkedPath = path.join(directory, 'linked.json');
        await symlink(store.path, linkedPath);
        await assert.rejects(new ConfigStore(linkedPath).load(), /enlace simbólico/);
    });
});

test('several runner credentials are selected by the workspace containing the current directory', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const firstWorkspace = path.join(directory, 'companies', 'first');
        const secondWorkspace = path.join(directory, 'companies', 'second');
        await mkdir(path.join(firstWorkspace, 'repo'), { recursive: true });
        await mkdir(secondWorkspace, { recursive: true });
        const firstConfiguration = {
            server_url: 'https://first.example',
            runner_id: 7,
            workspace_path: firstWorkspace,
            allow_insecure_localhost: false,
            api_token: 'first-token',
        };
        const secondConfiguration = {
            server_url: 'https://second.example',
            runner_id: 8,
            workspace_path: secondWorkspace,
            allow_insecure_localhost: false,
            api_token: 'second-token',
        };

        await store.saveNew(firstConfiguration);
        await store.saveNew(secondConfiguration);

        assert.deepEqual(await store.loadForDirectory(path.join(firstWorkspace, 'repo')), firstConfiguration);
        assert.deepEqual(await store.loadForDirectory(secondWorkspace), secondConfiguration);
        await store.forget(secondWorkspace);
        await assert.rejects(store.loadForDirectory(secondWorkspace), /No hay un Runner configurado para esta carpeta/);
        assert.deepEqual(await store.loadForDirectory(firstWorkspace), firstConfiguration);
    });
});

test('the most specific workspace wins when registered workspaces are nested', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const companyDirectory = path.join(directory, 'company');
        const projectDirectory = path.join(companyDirectory, 'project');
        await mkdir(projectDirectory, { recursive: true });
        const createConfiguration = (runnerId, workspacePath) => ({
            server_url: 'https://mycompanies.example',
            runner_id: runnerId,
            workspace_path: workspacePath,
            allow_insecure_localhost: false,
            api_token: `${runnerId}-token`,
        });

        await store.saveNew(createConfiguration(7, companyDirectory));
        await store.saveNew(createConfiguration(8, projectDirectory));

        assert.equal((await store.loadForDirectory(projectDirectory)).runner_id, 8);
    });
});

test('legacy single-runner configuration remains selectable by its workspace directory', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configuration = {
            server_url: 'https://mycompanies.example',
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: false,
            api_token: 'legacy-token',
        };
        await mkdir(path.dirname(store.path), { recursive: true });
        await writeFile(store.path, JSON.stringify(configuration), { mode: 0o600 });

        assert.deepEqual(await store.loadForDirectory(workspacePath), configuration);
    });
});
