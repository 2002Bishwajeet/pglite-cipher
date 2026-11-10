// node --test scripts/harness/select.test.mjs  (no dependencies: runs before the scaffold exists)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDependsOn, parseRouting, classify } from './select.mjs';

const body = (meta) => `## Context\nx\n\n## Metadata\n${meta}\n`;
const issue = (meta, labels = ['agent-ready']) => ({ state: 'OPEN', labels: labels.map((name) => ({ name })), body: body(meta) });

test('Depends on: none, a list, and malformed lines', () => {
    assert.deepEqual(parseDependsOn(body('Depends on: none')), []);
    assert.deepEqual(parseDependsOn(body('Depends on: #2, #13')), [2, 13]);
    assert.equal(parseDependsOn(body('Depends on: #<PC-02>')), null); // an unfilled placeholder fails closed
    assert.equal(parseDependsOn(body('Depends on: #2\nDepends on: #3')), null);
    assert.equal(parseDependsOn('no metadata'), null);
});

test('routing reads Model, Effort and Review, and ignores unknown values', () => {
    assert.deepEqual(parseRouting(body('Model: fable\nEffort: max\nReview: opus')), { model: 'fable', effort: 'max', review: 'opus' });
    assert.deepEqual(parseRouting(body('Model: gpt\nEffort: extreme')), {});
});

test('classify: ready only when agent-ready, unblocked and every dependency is closed as completed', () => {
    const deps = { 2: { state: 'CLOSED', stateReason: 'COMPLETED' } };
    assert.deepEqual(classify(issue('Depends on: #2'), { subIssueCount: 0, deps }), { ready: true });
    assert.equal(classify(issue('Depends on: #2', ['agent-ready', 'blocked']), { subIssueCount: 0, deps }).ready, false);
    assert.equal(classify(issue('Depends on: #2'), { subIssueCount: 0, deps: { 2: { state: 'OPEN' } } }).ready, false);
    assert.equal(classify(issue('Depends on: #2'), { subIssueCount: 0, deps: { 2: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } } }).ready, false);
    assert.equal(classify(issue('Depends on: none'), { subIssueCount: 0, openPrForIssue: 9, deps: {} }).ready, false);
});
