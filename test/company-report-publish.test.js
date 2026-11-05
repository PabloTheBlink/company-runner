import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { COMPANY_REPORT_PUBLISH_CAPABILITY, runCompanyReportPublish } from '../src/capabilities/company-report-publish.js';

async function withCompanyRoot(runTest) {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-report-test-'));
    await mkdir(path.join(companyRoot, 'reports'));
    try {
        await runTest(companyRoot);
    } finally {
        await rm(companyRoot, { recursive: true, force: true });
    }
}

test('report publication reads only the authorized UTF-8 report under reports', async () => {
    await withCompanyRoot(async (companyRoot) => {
        await writeFile(path.join(companyRoot, 'reports', 'market-review.md'), '# Market\n\nFindings.');

        assert.deepEqual(await runCompanyReportPublish({
            companyRoot,
            parameters: { path: 'reports/market-review.md', title: 'Market review' },
        }), {
            title: 'Market review',
            original_filename: 'market-review.md',
            content: '# Market\n\nFindings.',
        });
        assert.equal(COMPANY_REPORT_PUBLISH_CAPABILITY.maxOutputBytes, 32_768);
    });
});

test('report publication rejects traversal, symlinks, unsupported files and oversized content', async () => {
    await withCompanyRoot(async (companyRoot) => {
        const outsidePath = path.join(companyRoot, 'private.txt');
        await writeFile(outsidePath, 'secret');
        await symlink(outsidePath, path.join(companyRoot, 'reports', 'linked.txt'));
        await writeFile(path.join(companyRoot, 'reports', 'payload.js'), 'code');
        await writeFile(path.join(companyRoot, 'reports', 'large.txt'), 'x'.repeat(32_769));

        await assert.rejects(runCompanyReportPublish({ companyRoot, parameters: { path: 'reports/../private.txt', title: 'Private' } }));
        await assert.rejects(runCompanyReportPublish({ companyRoot, parameters: { path: 'reports/linked.txt', title: 'Linked' } }));
        await assert.rejects(runCompanyReportPublish({ companyRoot, parameters: { path: 'reports/payload.js', title: 'Code' } }));
        await assert.rejects(runCompanyReportPublish({ companyRoot, parameters: { path: 'reports/large.txt', title: 'Large' } }));
        await assert.rejects(runCompanyReportPublish({ companyRoot, parameters: { path: 'reports/market.md', title: 'bad', extra: true } }));
    });
});
