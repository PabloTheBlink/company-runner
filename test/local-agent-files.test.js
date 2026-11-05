import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyLocalAgentFileWrites, stageLocalAgentFiles } from '../src/local-agent-files.js';

async function withLocalFileWorkspace(runTest) {
    const testRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-files-test-'));
    const companyRoot = path.join(testRoot, 'company');
    const stagingRoot = path.join(testRoot, 'staged');

    try {
        await mkdir(companyRoot);
        await mkdir(stagingRoot, { mode: 0o700 });
        await runTest({ companyRoot, stagingRoot, testRoot });
    } finally {
        await rm(testRoot, { recursive: true, force: true });
    }
}

test('stages only files granted to the selected Agent and applies only granted writes', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
        await writeFile(path.join(companyRoot, '.env'), 'API_KEY=original-secret\n', { mode: 0o600 });
        await writeFile(path.join(companyRoot, 'README.md'), 'Company notes\n');
        await writeFile(path.join(companyRoot, 'private.txt'), 'Another Agent file\n');

        const grants = [
            { agentId: 12, path: '.env', operations: ['read', 'write'] },
            { agentId: 12, path: 'README.md', operations: ['read'] },
            { agentId: 13, path: 'private.txt', operations: ['read', 'write'] },
        ];
        const workspace = await stageLocalAgentFiles({
            agentId: 12,
            grants,
            companyRoot,
            stagingRoot,
        });

        assert.deepEqual((await readdir(stagingRoot)).sort(), ['.env', 'README.md']);
        assert.equal(await readFile(path.join(stagingRoot, '.env'), 'utf8'), 'API_KEY=original-secret\n');
        assert.equal((await lstat(path.join(stagingRoot, '.env'))).mode & 0o777, 0o600);

        await writeFile(path.join(stagingRoot, '.env'), 'API_KEY=updated-secret\n');
        await writeFile(path.join(stagingRoot, 'README.md'), 'changed without write grant\n');
        const writtenPaths = await applyLocalAgentFileWrites({
            agentId: 12,
            grants,
            companyRoot,
            stagingRoot,
            workspace,
        });

        assert.deepEqual(writtenPaths, ['.env']);
        assert.equal(await readFile(path.join(companyRoot, '.env'), 'utf8'), 'API_KEY=updated-secret\n');
        assert.equal(await readFile(path.join(companyRoot, 'README.md'), 'utf8'), 'Company notes\n');
        assert.equal(await readFile(path.join(companyRoot, 'private.txt'), 'utf8'), 'Another Agent file\n');
    });
});

test('write-only grants stage a blank file and may update the authorized target', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
        await writeFile(path.join(companyRoot, '.env'), 'SECRET=hidden-from-agent\n', { mode: 0o600 });
        const grants = [{ agentId: 12, path: '.env', operations: ['write'] }];
        const workspace = await stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot });

        assert.equal(await readFile(path.join(stagingRoot, '.env'), 'utf8'), '');
        await writeFile(path.join(stagingRoot, '.env'), 'SECRET=replaced\n');
        await applyLocalAgentFileWrites({ agentId: 12, grants, companyRoot, stagingRoot, workspace });

        assert.equal(await readFile(path.join(companyRoot, '.env'), 'utf8'), 'SECRET=replaced\n');
    });
});

test('write grants leave a new file absent in staging so the Agent can create it', async () => {
    for (const operations of [['write'], ['read', 'write']]) {
        await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
            await mkdir(path.join(companyRoot, 'reports'));
            const grants = [{ agentId: 12, path: 'reports/brief.md', operations }];
            const workspace = await stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot });
            const stagedPath = path.join(stagingRoot, 'reports', 'brief.md');

            await assert.rejects(lstat(stagedPath), { code: 'ENOENT' });
            await writeFile(stagedPath, '# Company brief\n');

            const writtenPaths = await applyLocalAgentFileWrites({ agentId: 12, grants, companyRoot, stagingRoot, workspace });

            assert.deepEqual(writtenPaths, ['reports/brief.md']);
            assert.equal(await readFile(path.join(companyRoot, 'reports', 'brief.md'), 'utf8'), '# Company brief\n');
            assert.equal((await lstat(path.join(companyRoot, 'reports', 'brief.md'))).mode & 0o777, 0o600);
        });
    }
});

test('refuses to overwrite a company file changed after staging', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
        const targetPath = path.join(companyRoot, '.env');
        await writeFile(targetPath, 'VERSION=before\n', { mode: 0o600 });
        const grants = [{ agentId: 12, path: '.env', operations: ['read', 'write'] }];
        const workspace = await stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot });
        await writeFile(path.join(stagingRoot, '.env'), 'VERSION=agent\n');
        await writeFile(targetPath, 'VERSION=concurrent-change\n');

        await assert.rejects(applyLocalAgentFileWrites({ agentId: 12, grants, companyRoot, stagingRoot, workspace }), /cambió después de preparar/);
        assert.equal(await readFile(targetPath, 'utf8'), 'VERSION=concurrent-change\n');
    });
});

test('rechecks write permission before applying staged changes', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
        const targetPath = path.join(companyRoot, '.env');
        await writeFile(targetPath, 'KEY=original\n', { mode: 0o600 });
        const grants = [{ agentId: 12, path: '.env', operations: ['read', 'write'] }];
        const workspace = await stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot });
        await writeFile(path.join(stagingRoot, '.env'), 'KEY=changed\n');

        const appliedPaths = await applyLocalAgentFileWrites({
            agentId: 12,
            grants: [{ agentId: 12, path: '.env', operations: ['read'] }],
            companyRoot,
            stagingRoot,
            workspace,
        });

        assert.deepEqual(appliedPaths, []);
        assert.equal(await readFile(targetPath, 'utf8'), 'KEY=original\n');
    });
});

test('rejects symbolic links while staging granted files', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot, testRoot }) => {
        const externalSecret = path.join(testRoot, 'outside.env');
        await writeFile(externalSecret, 'OUTSIDE=secret\n', { mode: 0o600 });
        await symlink(externalSecret, path.join(companyRoot, '.env'));
        const grants = [{ agentId: 12, path: '.env', operations: ['read', 'write'] }];

        await assert.rejects(stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot }), /enlace simbólico/);
        assert.deepEqual(await readdir(stagingRoot), []);
    });
});

test('requires a private staging directory outside the company root', async () => {
    await withLocalFileWorkspace(async ({ companyRoot, stagingRoot }) => {
        const grants = [{ agentId: 12, path: '.env', operations: ['read'] }];
        await chmod(stagingRoot, 0o755);

        await assert.rejects(stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot }), /privada/);

        const nestedStagingRoot = path.join(companyRoot, 'staging');
        await mkdir(nestedStagingRoot, { mode: 0o700 });
        await assert.rejects(stageLocalAgentFiles({ agentId: 12, grants, companyRoot, stagingRoot: nestedStagingRoot }), /fuera de la carpeta de empresa/);
    });
});
