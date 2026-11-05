import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DEVTO_STATS_TOTALS_CAPABILITY, runDevtoStatsTotals } from '../src/capabilities/devto-stats-totals.js';

async function withDevtoWorkspace(runTest) {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-devto-test-'));
    const scriptPath = path.join(companyRoot, 'automations', 'devto', 'devto_stats.py');
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, '# test fixture; never executed\n');

    try {
        await runTest(companyRoot, scriptPath);
    } finally {
        await rm(companyRoot, { recursive: true, force: true });
    }
}

const validOutput = JSON.stringify({
    source: 'Dev.to API /api/analytics/totals',
    scope: 'lifetime totals',
    articles: [{
        id: 42,
        title: 'A private title that is omitted',
        url: 'https://dev.to/example/article',
        published_at: '2026-11-04T10:00:00Z',
        tags: ['laravel'],
        metrics: { page_views_count: 123, reactions_count: 4, comments_count: 2 },
    }],
});

test('Dev.to stats capability invokes only the fixed local read only operation and returns bounded metrics', async () => {
    await withDevtoWorkspace(async (companyRoot, scriptPath) => {
        let invocation;
        const originalSentinel = process.env.MYCOMPANY_TEST_SECRET;
        process.env.MYCOMPANY_TEST_SECRET = 'local test sentinel';
        let result;
        try {
            result = await runDevtoStatsTotals({
                companyRoot,
                timeoutMs: 90_000,
                execFileImplementation(executable, args, options, callback) {
                    invocation = { executable, args, options };
                    callback(null, validOutput, 'progress output is discarded');
                },
            });
        } finally {
            if (originalSentinel === undefined) {
                delete process.env.MYCOMPANY_TEST_SECRET;
            } else {
                process.env.MYCOMPANY_TEST_SECRET = originalSentinel;
            }
        }

        assert.deepEqual(result, {
            source: 'Dev.to analytics',
            scope: 'lifetime totals',
            articles: [{ id: 42, metrics: { page_views_count: 123, reactions_count: 4, comments_count: 2 } }],
        });
        assert.equal(invocation.executable, 'python3');
        assert.deepEqual(invocation.args, ['automations/devto/devto_stats.py', 'stats', 'totals']);
        assert.equal(invocation.options.cwd, companyRoot);
        assert.equal(invocation.options.shell, false);
        assert.equal(invocation.options.timeout, 90_000);
        assert.equal(invocation.options.maxBuffer, DEVTO_STATS_TOTALS_CAPABILITY.maxOutputBytes + 1);
        assert.equal(invocation.options.env.MYCOMPANY_TEST_SECRET, undefined);
        assert.equal(invocation.options.env.PYTHONIOENCODING, 'utf-8');
        assert.equal(scriptPath.startsWith(companyRoot), true);
    });
});

test('Dev.to stats capability flattens the real nested analytics response for Agent summaries', async () => {
    await withDevtoWorkspace(async (companyRoot) => {
        const output = JSON.stringify({
            source: 'Dev.to API /api/analytics/totals',
            scope: 'lifetime totals',
            articles: [{
                id: 42,
                title: 'Omitted title',
                metrics: {
                    comments: { total: 2 },
                    reactions: { total: 4, like: 3 },
                    page_views: { total: 123, average_read_time_in_seconds: 17, total_read_time_in_seconds: 246 },
                },
            }],
        });
        const result = await runDevtoStatsTotals({
            companyRoot,
            execFileImplementation(_executable, _args, _options, callback) {
                callback(null, output, '');
            },
        });

        assert.deepEqual(result.articles[0].metrics, {
            comments_total: 2,
            reactions_total: 4,
            reactions_like: 3,
            page_views_total: 123,
            page_views_average_read_time_in_seconds: 17,
            page_views_total_read_time_in_seconds: 246,
        });
        assert.deepEqual(DEVTO_STATS_TOTALS_CAPABILITY.agentTool.summarize(result), {
            source: 'Dev.to analytics',
            scope: 'lifetime totals',
            article_count: 1,
            totals: {
                comments_total: 2,
                reactions_total: 4,
                reactions_like: 3,
                page_views_total: 123,
                page_views_total_read_time_in_seconds: 246,
            },
            calculated_weighted_average_read_time_seconds: 2,
        });
    });
});

test('Dev.to stats capability rejects a missing or out of root script without invoking Python', async () => {
    await withDevtoWorkspace(async (companyRoot, scriptPath) => {
        const missingRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-devto-missing-'));
        let externalDirectory;
        let invocationCount = 0;

        try {
            await assert.rejects(runDevtoStatsTotals({
                companyRoot: missingRoot,
                execFileImplementation() {
                    invocationCount++;
                },
            }), /capacidad Dev.to no está instalada/);

            externalDirectory = await mkdtemp(path.join(process.cwd(), '.mycompany-devto-external-'));
            const externalScript = path.join(externalDirectory, 'external.py');
            await writeFile(externalScript, '# external script\n');
            await rm(scriptPath);
            await symlink(externalScript, scriptPath);

            await assert.rejects(runDevtoStatsTotals({
                companyRoot,
                execFileImplementation() {
                    invocationCount++;
                },
            }), /capacidad Dev.to no está instalada/);
        } finally {
            await rm(missingRoot, { recursive: true, force: true });
            if (externalDirectory !== undefined) {
                await rm(externalDirectory, { recursive: true, force: true });
            }
        }

        assert.equal(invocationCount, 0);
    });
});

test('Dev.to stats capability rejects oversized or malformed output without returning it', async () => {
    await withDevtoWorkspace(async (companyRoot) => {
        const oversized = `${validOutput}${' '.repeat(DEVTO_STATS_TOTALS_CAPABILITY.maxOutputBytes)}`;
        const invoke = (stdout) => runDevtoStatsTotals({
            companyRoot,
            execFileImplementation(_executable, _args, _options, callback) {
                callback(null, stdout, 'sensitive stderr must not escape');
            },
        });

        await assert.rejects(invoke(oversized), /demasiado grande/);
        await assert.rejects(invoke('{invalid json'), /JSON de Dev.to no es válida/);
    });
});

test('Dev.to stats capability rejects invalid metric structures and hides process errors', async () => {
    await withDevtoWorkspace(async (companyRoot) => {
        const invalidMetrics = JSON.stringify({
            source: 'Dev.to API /api/analytics/totals',
            scope: 'lifetime totals',
            articles: [{ id: 42, metrics: { secret: 'do not report' } }],
        });

        await assert.rejects(runDevtoStatsTotals({
            companyRoot,
            execFileImplementation(_executable, _args, _options, callback) {
                callback(null, invalidMetrics, '');
            },
        }), /respuesta de métricas Dev.to no es válida/);

        await assert.rejects(runDevtoStatsTotals({
            companyRoot,
            execFileImplementation(_executable, _args, _options, callback) {
                callback(new Error('secret API key must not escape'), '', 'secret API key must not escape');
            },
        }), (error) => {
            assert.match(error.message, /falló/);
            assert.equal(error.message.includes('secret API key'), false);
            return true;
        });

        await assert.rejects(runDevtoStatsTotals({
            companyRoot,
            execFileImplementation() {
                throw new Error('secret API key must not escape');
            },
        }), (error) => {
            assert.match(error.message, /falló/);
            assert.equal(error.message.includes('secret API key'), false);
            return true;
        });
    });
});
