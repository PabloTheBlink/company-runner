import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { initializeWorkspace } from '../src/workspace-kit.js';

async function withTemporaryDirectory(runTest) {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-kit-'));
    try {
        await runTest(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('workspace initialization creates shared assistant instructions and company work folders', async () => {
    await withTemporaryDirectory(async (directory) => {
        const result = await initializeWorkspace(directory);

        assert.deepEqual(result.created.sort(), [
            '.mycompanies/README.md',
            'AGENTS.md',
            'CLAUDE.md',
            'automations/README.md',
            'tasks/README.md',
        ]);
        assert.match(await readFile(path.join(directory, 'AGENTS.md'), 'utf8'), /MyCompanies workspace instructions/);
        assert.match(await readFile(path.join(directory, 'CLAUDE.md'), 'utf8'), /MyCompanies workspace instructions/);
        assert.match(await readFile(path.join(directory, 'automations/README.md'), 'utf8'), /approved recurring scripts/);
        assert.deepEqual((await readdir(path.join(directory, '.mycompanies'))).sort(), ['README.md']);
    });
});

test('workspace sync updates only its managed instruction block and preserves user content', async () => {
    await withTemporaryDirectory(async (directory) => {
        await writeFile(path.join(directory, 'AGENTS.md'), '# My company\n\nMy own rules.\n');
        await initializeWorkspace(directory);
        const originalInstructions = await readFile(path.join(directory, 'AGENTS.md'), 'utf8');
        await writeFile(path.join(directory, 'AGENTS.md'), `${originalInstructions.replace('Keep human work, AI-assisted work, and scheduled script automations distinct.', 'Old instructions.') }\n## Local addition\nKeep this.\n`);

        const result = await initializeWorkspace(directory);
        const instructions = await readFile(path.join(directory, 'AGENTS.md'), 'utf8');

        assert.equal(result.updated.includes('AGENTS.md'), true);
        assert.match(instructions, /My own rules\./);
        assert.match(instructions, /Keep this\./);
        assert.equal((instructions.match(/BEGIN MYCOMPANIES MANAGED INSTRUCTIONS/g) ?? []).length, 1);
        assert.equal((instructions.match(/END MYCOMPANIES MANAGED INSTRUCTIONS/g) ?? []).length, 1);
    });
});

test('workspace initialization does not replace existing project files or follow symlinks', async () => {
    await withTemporaryDirectory(async (directory) => {
        const externalPath = path.join(directory, 'external.md');
        const projectPath = path.join(directory, 'project');
        await mkdir(projectPath);
        await writeFile(externalPath, 'Do not modify.\n');
        await symlink(externalPath, path.join(projectPath, 'AGENTS.md'));

        await assert.rejects(initializeWorkspace(projectPath), /symbolic link/);
        assert.equal(await readFile(externalPath, 'utf8'), 'Do not modify.\n');
    });
});

test('workspace sync leaves custom scaffold files untouched and rejects incomplete managed markers', async () => {
    await withTemporaryDirectory(async (directory) => {
        const customGuide = path.join(directory, '.mycompanies', 'README.md');
        const instructions = path.join(directory, 'AGENTS.md');
        await mkdir(path.dirname(customGuide), { recursive: true });
        await writeFile(customGuide, 'Company-owned guide.\n');
        await writeFile(instructions, '<!-- BEGIN MYCOMPANIES MANAGED INSTRUCTIONS -->\npartial\n');

        await assert.rejects(initializeWorkspace(directory), /incompletas/);
        assert.equal(await readFile(customGuide, 'utf8'), 'Company-owned guide.\n');
        assert.equal(await readFile(instructions, 'utf8'), '<!-- BEGIN MYCOMPANIES MANAGED INSTRUCTIONS -->\npartial\n');
        await assert.rejects(access(path.join(directory, 'tasks')));
    });
});
