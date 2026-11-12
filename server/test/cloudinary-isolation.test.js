'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, user, application, task, employment } = require('../testing/fixtures');
const cloudinaryConfig = require('../config/cloudinary');

let client;

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
  delete process.env.CLOUDINARY_FOLDER_PREFIX;
});

const CLOUDINARY_ENV = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
};

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withCloudinaryEnv(prefix, run) {
  const names = [...Object.keys(CLOUDINARY_ENV), 'CLOUDINARY_FOLDER_PREFIX'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  Object.assign(process.env, CLOUDINARY_ENV);
  if (prefix === undefined) {
    delete process.env.CLOUDINARY_FOLDER_PREFIX;
  } else {
    process.env.CLOUDINARY_FOLDER_PREFIX = prefix;
  }

  try {
    return await run();
  } finally {
    for (const name of names) restoreEnv(name, saved[name]);
  }
}

async function withCloudinaryAssets(foundPublicIds, run) {
  const original = cloudinaryConfig.cloudinary.api.resource;

  cloudinaryConfig.cloudinary.api.resource = async (publicId) => {
    if (foundPublicIds.includes(publicId)) {
      return { public_id: publicId, resource_type: 'raw' };
    }

    const missing = new Error('Resource not found');
    missing.http_code = 404;
    throw missing;
  };

  try {
    return await run();
  } finally {
    cloudinaryConfig.cloudinary.api.resource = original;
  }
}

async function withDeletedAssets(run) {
  const original = cloudinaryConfig.cloudinary.uploader.destroy;
  const deleted = [];

  cloudinaryConfig.cloudinary.uploader.destroy = async (publicId) => {
    deleted.push(publicId);
    return { result: 'ok' };
  };

  try {
    return await run(deleted);
  } finally {
    cloudinaryConfig.cloudinary.uploader.destroy = original;
  }
}

function seedTaskWorld() {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );
  client.seed(
    'tasks',
    'task-1',
    task({
      jobId: 'job-1',
      employeeId: 'employee-1',
      applicationId: 'app-1',
      employmentId: 'emp-1',
      submissionType: 'file',
    })
  );
}

test('an unset folder prefix preserves the historical Cloudinary folders', async () => {
  await withCloudinaryEnv(undefined, async () => {
    const api = await client.authed('user-1');

    const profile = await api.post('/users/profile-photo/signature', { body: {} });
    const resume = await api.post('/users/resume/signature', { body: {} });

    assert.equal(profile.status, 200);
    assert.equal(profile.body.folder, 'profilePics/user-1');
    assert.equal(resume.status, 200);
    assert.equal(resume.body.folder, 'resumes/user-1');
  });
});

test('the configured folder prefix applies to profile, resume and task upload paths', async () => {
  await withCloudinaryEnv('kachploy/staging', async () => {
    seedTaskWorld();

    const api = await client.authed('user-1');
    const profile = await api.post('/users/profile-photo/signature', { body: {} });
    const resume = await api.post('/users/resume/signature', { body: {} });

    const employee = await client.authed('employee-1');
    const submission = await employee.post('/tasks/task-1/upload-signature', { body: {} });

    assert.equal(profile.status, 200);
    assert.equal(profile.body.folder, 'kachploy/staging/profilePics/user-1');
    assert.equal(resume.status, 200);
    assert.equal(resume.body.folder, 'kachploy/staging/resumes/user-1');
    assert.equal(submission.status, 200);
    assert.equal(submission.body.folder, 'kachploy/staging/taskSubmissions/task-1');
  });
});

test('folder prefix normalization removes surrounding slashes', async () => {
  await withCloudinaryEnv(' /kachploy/staging/ ', async () => {
    assert.equal(cloudinaryConfig.getFolderPrefix(), 'kachploy/staging');
    assert.equal(
      cloudinaryConfig.qualifyFolder('profilePics/user-1'),
      'kachploy/staging/profilePics/user-1'
    );
  });
});

test('an unsafe folder prefix is refused', async () => {
  await withCloudinaryEnv('../development', async () => {
    assert.throws(
      () => cloudinaryConfig.getFolderPrefix(),
      (error) =>
        error instanceof cloudinaryConfig.CloudinaryConfigurationError &&
        error.code === 'CLOUDINARY_FOLDER_PREFIX_INVALID'
    );
  });
});

test('resume ownership accepts an asset under the configured prefix', async () => {
  const publicId = 'kachploy/staging/resumes/user-1/resume-abc123';

  await withCloudinaryAssets([publicId], () =>
    withCloudinaryEnv('kachploy/staging', async () => {
      client.seed('users', 'user-1', user({ uid: 'user-1' }));
      const api = await client.authed('user-1');

      const res = await api.put('/users/update/user-1', {
        body: { resume: { publicId, name: 'cv.pdf', resourceType: 'raw' } },
      });

      assert.equal(res.status, 200);
      assert.equal(client.readDoc('users', 'user-1').resume.publicId, publicId);
    })
  );
});

test('resume ownership rejects an unprefixed development asset when a prefix is configured', async () => {
  const publicId = 'resumes/user-1/resume-abc123';

  await withCloudinaryAssets([publicId], () =>
    withCloudinaryEnv('kachploy/staging', async () => {
      client.seed('users', 'user-1', user({ uid: 'user-1' }));
      const api = await client.authed('user-1');

      const res = await api.put('/users/update/user-1', {
        body: { resume: { publicId, name: 'cv.pdf', resourceType: 'raw' } },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.message, 'Resume does not belong to you');
    })
  );
});

test('task submission validation accepts a prefixed reference', async () => {
  await withCloudinaryEnv('kachploy/staging', async () => {
    seedTaskWorld();
    const publicId = 'kachploy/staging/taskSubmissions/task-1/1735689600000-abc123';

    const res = await (await client.authed('employee-1')).post('/tasks/task-1/submit', {
      body: {
        submissionFile: {
          url: `https://res.cloudinary.com/demo/raw/upload/v1/${publicId}`,
          publicId,
          name: 'evidence.pdf',
          resourceType: 'raw',
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(client.readDoc('tasks', 'task-1').submissionFile.publicId, publicId);
  });
});

test('task submission validation rejects an unprefixed reference when a prefix is configured', async () => {
  await withCloudinaryEnv('kachploy/staging', async () => {
    seedTaskWorld();
    const publicId = 'taskSubmissions/task-1/1735689600000-abc123';

    const res = await (await client.authed('employee-1')).post('/tasks/task-1/submit', {
      body: {
        submissionFile: {
          url: `https://res.cloudinary.com/demo/raw/upload/v1/${publicId}`,
          publicId,
          name: 'evidence.pdf',
          resourceType: 'raw',
        },
      },
    });

    assert.equal(res.status, 400);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
  });
});

test('profile-photo cleanup deletes only assets under the configured prefix', async () => {
  await withDeletedAssets((deleted) =>
    withCloudinaryEnv('kachploy/staging', async () => {
      client.seed(
        'users',
        'user-1',
        user({
          uid: 'user-1',
          profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/kachploy/staging/profilePics/user-1/old.png',
          profilePicPublicId: 'kachploy/staging/profilePics/user-1/old',
        })
      );
      const api = await client.authed('user-1');

      const res = await api.put('/users/update/user-1', {
        body: {
          profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/kachploy/staging/profilePics/user-1/new.png',
          profilePicPublicId: 'kachploy/staging/profilePics/user-1/new',
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(deleted, ['kachploy/staging/profilePics/user-1/old']);
    })
  );
});

test('profile-photo cleanup leaves an unprefixed development asset alone', async () => {
  await withDeletedAssets((deleted) =>
    withCloudinaryEnv('kachploy/staging', async () => {
      client.seed(
        'users',
        'user-1',
        user({
          uid: 'user-1',
          profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/old.png',
          profilePicPublicId: 'profilePics/user-1/old',
        })
      );
      const api = await client.authed('user-1');

      const res = await api.put('/users/update/user-1', {
        body: {
          profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/kachploy/staging/profilePics/user-1/new.png',
          profilePicPublicId: 'kachploy/staging/profilePics/user-1/new',
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(deleted, []);
    })
  );
});
