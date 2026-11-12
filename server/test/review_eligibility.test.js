'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { employment, job } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;

const all = (collection) => Object.values(client.readAll(collection));

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  client.seed('employments', 'emp-1', employment());
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

test('an employer cannot review while the employment is active and the job is open', async () => {
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  const res = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /completed or terminated|job is closed/i);
  assert.equal(all('reviews').length, 0);
});

test('a filled job does not make an active employment reviewable', async () => {
  for (const status of ['filled', 'Filled']) {
    client.fake.resetAll();
    client.seed('employments', 'emp-1', employment());
    client.seed('jobs', 'job-1', job({ status }));
    employerApi = await client.authed('employer-1');

    const res = await employerApi.post('/employments/emp-1/reviews', {
      body: { revieweeId: 'employee-1', rating: 5 },
    });

    assert.equal(res.status, 409, `expected a ${status} job to block a review`);
    assert.equal(all('reviews').length, 0);
  }
});

test('an employer may review once the job is closed', async () => {
  for (const status of ['closed', 'Closed']) {
    client.fake.resetAll();
    client.seed('employments', 'emp-1', employment());
    client.seed('jobs', 'job-1', job({ status }));
    employerApi = await client.authed('employer-1');

    const res = await employerApi.post('/employments/emp-1/reviews', {
      body: { revieweeId: 'employee-1', rating: 5 },
    });

    assert.equal(res.status, 201, `expected a ${status} job to allow a review`);
    assert.equal(all('reviews').length, 1);
  }
});

test('an active employment becomes reviewable after the job is refreshed to closed', async () => {
  client.seed('jobs', 'job-1', job({ status: 'filled' }));

  const blocked = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(blocked.status, 409);
  assert.equal(all('reviews').length, 0);

  client.seed('jobs', 'job-1', job({ status: 'closed' }));

  const allowed = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(allowed.status, 201);
  assert.equal(all('reviews').length, 1);
});

test('an employer may review a completed employment even when the job cannot be checked', async () => {
  client.seed('employments', 'emp-1', employment({ status: 'completed' }));

  const res = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 4 },
  });

  assert.equal(res.status, 201);
  assert.equal(all('reviews').length, 1);
});

test('an employer may review a terminated employment with an open job', async () => {
  client.seed('employments', 'emp-1', employment({ status: 'terminated' }));
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  const res = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 4 },
  });

  assert.equal(res.status, 201);
});

test('an active employment fails closed when the job is missing or inconsistent', async () => {
  const missing = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(missing.status, 409);

  client.seed('jobs', 'job-1', job({ status: 'closed', postedBy: 'someone-else' }));
  const inconsistent = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(inconsistent.status, 409);
  assert.equal(all('reviews').length, 0);
});

test('an employee may still review the employer while the employment is active', async () => {
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  const res = await employeeApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employer-1', rating: 4 },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.review.reviewerId, 'employee-1');
  assert.equal(res.body.review.revieweeId, 'employer-1');
  assert.equal(all('reviews').length, 1);
});
