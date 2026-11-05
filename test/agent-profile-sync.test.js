import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { syncAgentProfileInstructions } from '../src/agent-profile-sync.js';

async function withCompanyRoot(runTest) {
    const root = await mkdtemp(path.join(process.cwd(), '.mycompany-profile-sync-test-'));
    try {
        await runTest(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const profile = {
    id: 12,
    uuid: 'c376a06b-8b47-4b50-9438-3a522af9f1fa',
    name: 'Vera',
    role: 'CEO',
    instructions: '# Instrucciones de Vera\n',
};

test('sync creates only the current UUID instructions file and is idempotent', async () => {
    await withCompanyRoot(async (companyRoot) => {
        const first = await syncAgentProfileInstructions(companyRoot, profile);
        const second = await syncAgentProfileInstructions(companyRoot, profile);
        assert.equal(first.status, 'created');
        assert.equal(second.status, 'unchanged');
        assert.equal(await readFile(path.join(companyRoot, 'agents', profile.uuid, 'instructions.md'), 'utf8'), profile.instructions);
        await assert.rejects(readFile(path.join(companyRoot, 'agents', String(profile.id), 'instructions.md')));
    });
});

test('sync preserves a pre-existing untracked profile file and reports a conflict', async () => {
    await withCompanyRoot(async (companyRoot) => {
        const target = path.join(companyRoot, 'agents', profile.uuid, 'instructions.md');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, '# Instrucciones locales\n');
        const result = await syncAgentProfileInstructions(companyRoot, profile);
        assert.equal(result.status, 'conflict');
        assert.equal(await readFile(target, 'utf8'), '# Instrucciones locales\n');
    });
});

test('sync updates a managed unchanged file but preserves later local edits', async () => {
    await withCompanyRoot(async (companyRoot) => {
        assert.equal((await syncAgentProfileInstructions(companyRoot, profile)).status, 'created');
        const updatedProfile = { ...profile, instructions: '# Nueva versión\n' };
        assert.equal((await syncAgentProfileInstructions(companyRoot, updatedProfile)).status, 'updated');
        const target = path.join(companyRoot, 'agents', profile.uuid, 'instructions.md');
        await writeFile(target, '# Edición local\n');
        assert.equal((await syncAgentProfileInstructions(companyRoot, { ...profile, instructions: '# Remota\n' })).status, 'conflict');
        assert.equal(await readFile(target, 'utf8'), '# Edición local\n');
    });
});
