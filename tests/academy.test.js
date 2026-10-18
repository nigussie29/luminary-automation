// Luminary Academy integration: its enrollment form posts here from another site,
// and Luminary Automation's tables stay in their own schema inside a shared Supabase project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('the Luminary Academy site can submit inquiries; other sites cannot read the response', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const pre = await env.http('OPTIONS', '/public/forms/bright-path/inquiries', { headers: { origin: 'https://theluminaryacademy.net', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  const bad = await env.rawFetch('/public/forms/bright-path/inquiries', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(bad.status, 403);

  const res = await env.rawFetch('/public/forms/bright-path/inquiries', {
    method: 'POST',
    headers: { origin: 'https://theluminaryacademy.net', 'content-type': 'application/json' },
    body: JSON.stringify({ parent_name: 'Abel', email: 'abel@example.com', message: 'I want to learn Python for data jobs', interest: 'Python Programming', source: 'luminary_academy' }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://theluminaryacademy.net');
  const other = await env.rawFetch('/public/forms/bright-path', { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);

  await new Promise((r) => setTimeout(r, 300));
  const [lead] = await env.db.query(`select * from leads where email='abel@example.com'`);
  assert.equal(lead.source, 'luminary_academy');
  assert.match(lead.message, /Interested in: Python Programming/);
  assert.equal(lead.subject, 'Computer Science');
});

test('all tables are created in the automation schema, none in public', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const rows = await env.db.query(`select table_schema, count(*)::int as n from information_schema.tables
                                   where table_name in ('workspaces','leads','messages','reminders','member_invites') group by table_schema`);
  assert.deepEqual(rows, [{ table_schema: 'automation', n: 5 }]);
});
