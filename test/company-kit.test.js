import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { initializeCompanyRoot } from '../src/company-kit.js';

async function withTemporaryDirectory(runTest) {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-kit-'));
    try {
        await runTest(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('company initialization creates assistant instructions and the fixed company structure', async () => {
    await withTemporaryDirectory(async (directory) => {
        const result = await initializeCompanyRoot(directory);

        assert.deepEqual(result.created.sort(), [
            '.mycompanies/README.md',
            'AGENTS.md',
            'CLAUDE.md',
            'agents/README.md',
            'architecture/README.md',
            'automations/README.md',
            'reports/README.md',
            'tasks/README.md',
        ]);
        assert.match(await readFile(path.join(directory, 'AGENTS.md'), 'utf8'), /company-root instructions/);
        const claudeInstructions = await readFile(path.join(directory, 'CLAUDE.md'), 'utf8');
        assert.match(claudeInstructions, /company-root instructions/);
        for (const instructions of [await readFile(path.join(directory, 'AGENTS.md'), 'utf8'), claudeInstructions]) {
            assert.match(instructions, /supported command is `mycompany`/);
            assert.match(instructions, /mycompany agent me/);
            assert.match(instructions, /mycompany agent tasks/);
            assert.match(instructions, /mycompany agent task ID/);
            assert.match(instructions, /mycompany agent goals/);
            assert.match(instructions, /`memory`/);
            assert.match(instructions, /role label such as CEO/);
            assert.match(instructions, /mycompany tasks/);
            assert.match(instructions, /Runner/);
            assert.match(instructions, /These commands read/);
            assert.match(instructions, /do not assume.*config file/i);
            assert.match(instructions, /company situation|company assessment/i);
            assert.match(instructions, /current CLI state/);
            assert.match(instructions, /follow the company's operating policy/i);
            assert.match(instructions, /routine internal decisions.*without asking the owner/i);
            assert.match(instructions, /effective permissions allow them/i);
            assert.match(instructions, /external actions and recurring automations.*configured capability/i);
        }
        assert.match(await readFile(path.join(directory, 'automations/README.md'), 'utf8'), /Each automation lives/);
        assert.match(await readFile(path.join(directory, 'reports/README.md'), 'utf8'), /company records/);
        assert.match(await readFile(path.join(directory, 'agents/README.md'), 'utf8'), /persistent agent/);
        assert.match(await readFile(path.join(directory, 'architecture/README.md'), 'utf8'), /technical and operational decisions/);
        assert.deepEqual((await readdir(path.join(directory, '.mycompanies'))).sort(), ['README.md']);
    });
});

test('company initialization updates both managed instruction blocks and preserves user content', async () => {
    await withTemporaryDirectory(async (directory) => {
        for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
            await writeFile(path.join(directory, filename), `# My company\n\nMy own rules in ${filename}.\n`);
        }
        await initializeCompanyRoot(directory);
        for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
            const originalInstructions = await readFile(path.join(directory, filename), 'utf8');
            await writeFile(path.join(directory, filename), `${originalInstructions.replace('The supported command is', 'The old command is')}\n## Local addition\nKeep this.\n`);
        }

        const result = await initializeCompanyRoot(directory);

        for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
            const instructions = await readFile(path.join(directory, filename), 'utf8');
            assert.equal(result.updated.includes(filename), true);
            assert.match(instructions, new RegExp(`My own rules in ${filename}\\.`));
            assert.match(instructions, /Keep this\./);
            assert.match(instructions, /The supported command is `mycompany`/);
            assert.equal((instructions.match(/BEGIN MYCOMPANIES MANAGED INSTRUCTIONS/g) ?? []).length, 1);
            assert.equal((instructions.match(/END MYCOMPANIES MANAGED INSTRUCTIONS/g) ?? []).length, 1);
        }
    });
});

test('company initialization does not replace existing project files or follow symlinks', async () => {
    await withTemporaryDirectory(async (directory) => {
        const externalPath = path.join(directory, 'external.md');
        const projectPath = path.join(directory, 'project');
        await mkdir(projectPath);
        await writeFile(externalPath, 'Do not modify.\n');
        await symlink(externalPath, path.join(projectPath, 'AGENTS.md'));

        await assert.rejects(initializeCompanyRoot(projectPath), /symbolic link/);
        assert.equal(await readFile(externalPath, 'utf8'), 'Do not modify.\n');
    });
});

test('company initialization preserves custom scaffold content and adds one managed section', async () => {
    await withTemporaryDirectory(async (directory) => {
        const customGuide = path.join(directory, 'architecture', 'README.md');
        await mkdir(path.dirname(customGuide), { recursive: true });
        await writeFile(customGuide, '# My architecture\n\nKeep this local guidance.\n');

        const firstResult = await initializeCompanyRoot(directory);
        const firstContent = await readFile(customGuide, 'utf8');
        const secondResult = await initializeCompanyRoot(directory);
        const secondContent = await readFile(customGuide, 'utf8');

        assert.equal(firstResult.updated.includes('architecture/README.md'), true);
        assert.match(firstContent, /Keep this local guidance\./);
        assert.match(firstContent, /BEGIN MYCOMPANIES MANAGED INSTRUCTIONS/);
        assert.equal(secondResult.unchanged.includes('architecture/README.md'), true);
        assert.equal(secondContent, firstContent);
        assert.equal((firstContent.match(/BEGIN MYCOMPANIES MANAGED INSTRUCTIONS/g) ?? []).length, 1);
    });
});

test('company initialization rejects incomplete managed markers before changing any files', async () => {
    await withTemporaryDirectory(async (directory) => {
        const customGuide = path.join(directory, '.mycompanies', 'README.md');
        const instructions = path.join(directory, 'AGENTS.md');
        await mkdir(path.dirname(customGuide), { recursive: true });
        await writeFile(customGuide, 'Company-owned guide.\n');
        await writeFile(instructions, '<!-- BEGIN MYCOMPANIES MANAGED INSTRUCTIONS -->\npartial\n');

        await assert.rejects(initializeCompanyRoot(directory), /incompletas/);
        assert.equal(await readFile(customGuide, 'utf8'), 'Company-owned guide.\n');
        assert.equal(await readFile(instructions, 'utf8'), '<!-- BEGIN MYCOMPANIES MANAGED INSTRUCTIONS -->\npartial\n');
        await assert.rejects(access(path.join(directory, 'tasks')));
    });
});
