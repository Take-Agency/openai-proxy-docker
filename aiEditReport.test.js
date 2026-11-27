import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createAIEditReportRouter } from './aiEditReport.js';

async function withServer(options, run) {
    const writes = [];
    const app = express();
    app.use(createAIEditReportRouter({
        s3Client: options.s3Client ?? { send: async (command) => { writes.push(command.input); } },
        spacesBucket: 'test-feedback',
        feedbackSecret: 'client-secret',
    }));
    const server = app.listen(0);
    const { port } = server.address();
    const post = async (body, headers = { 'x-feedback-secret': 'client-secret' }) => {
        const response = await fetch(`http://127.0.0.1:${port}/edit/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-install-id': 'install-1', ...headers },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    try {
        await run(post, writes);
    } finally {
        server.close();
    }
}

const conversation = ['User: re-remove the silences', 'AI Edit asked: Remove what? Options: Captions / Background'];

test('a report is stored whole under ai-edit-reports/<date>/', async () => {
    await withServer({}, async (post, writes) => {
        const { status, body } = await post({ conversation, note: ' it lost the context ', contact: 'me@example.com', snapshot: 'c0 0.0-1.2 | 0 Hello', appVersion: '4.0 (6)', locale: 'en' });
        assert.equal(status, 200);
        assert.equal(writes.length, 1);
        assert.match(writes[0].Key, /^ai-edit-reports\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.json$/);
        const record = JSON.parse(writes[0].Body);
        assert.equal(record.reportId, body.reportId);
        assert.deepEqual(record.conversation, conversation);
        assert.equal(record.note, 'it lost the context');
        assert.equal(record.contact, 'me@example.com');
        assert.equal(record.installId, 'install-1');
        assert.equal(record.snapshot, 'c0 0.0-1.2 | 0 Hello');
        assert.equal(record.arms, null);
    });
});

test('a report keeps the A/B arms the reporter is in, and drops anything else', async () => {
    await withServer({}, async (post, writes) => {
        const { status } = await post({ conversation, arms: { ai_edit_start_tool: 'style', 'Bad Name!': 'x', long_arm: 'y'.repeat(41), nested: { a: 1 } } });
        assert.equal(status, 200);
        assert.deepEqual(JSON.parse(writes[0].Body).arms, { ai_edit_start_tool: 'style' });
        await post({ conversation, arms: ['style'] });
        assert.equal(JSON.parse(writes[1].Body).arms, null);
    });
});

test('a report needs the app secret and a conversation of at most 10 lines', async () => {
    await withServer({}, async (post, writes) => {
        assert.equal((await post({ conversation }, {})).status, 401);
        assert.equal((await post({ conversation: [] })).status, 400);
        assert.equal((await post({ conversation: Array(11).fill('User: hi') })).status, 400);
        assert.equal((await post({ conversation: ['x'.repeat(2001)] })).status, 400);
        assert.equal((await post({ conversation, note: 'x'.repeat(2001) })).status, 400);
        assert.equal((await post({ conversation, snapshot: 'x'.repeat(40_001) })).status, 400);
        assert.equal(writes.length, 0);
        // an empty note and no contact are fine: the conversation is the report
        assert.equal((await post({ conversation, note: '' })).status, 200);
    });
});

test('a storage failure is a 502, not a silent success', async () => {
    await withServer({ s3Client: { send: async () => { throw new Error('down'); } } }, async (post) => {
        assert.equal((await post({ conversation })).status, 502);
    });
});
