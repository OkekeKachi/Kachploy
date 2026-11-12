'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PaystackHttpError,
    createPaystackTransferClient,
} = require('../services/paystackTransferClient');

const FAKE_KEY = 'sk_test_transfer_client_FAKE';
const savedKey = process.env.PAYSTACK_SECRET_KEY;

test.beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = FAKE_KEY;
});

test.after(() => {
    if (savedKey === undefined) {
        delete process.env.PAYSTACK_SECRET_KEY;
    } else {
        process.env.PAYSTACK_SECRET_KEY = savedKey;
    }
});

const fakeResponse = (body, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    text() {
        return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
    },
});

const recordingFetch = (answer) => {
    const calls = [];
    const fetchImpl = (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(answer(url, init, calls.length));
    };
    return { calls, fetchImpl };
};

test('listBanks requests the NGN bank directory with no body', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
        fakeResponse({ status: true, data: [{ name: 'Access Bank', code: '044' }] })
    );
    const client = createPaystackTransferClient(fetchImpl);

    const result = await client.listBanks({ currency: 'NGN' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.paystack.co/bank?currency=NGN');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.deepEqual(result.data, [{ name: 'Access Bank', code: '044' }]);
});

test('resolveAccount query-encodes both caller values', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
        fakeResponse({ status: true, data: { account_name: 'Ada Employee' } })
    );
    const client = createPaystackTransferClient(fetchImpl);

    await client.resolveAccount('0123456789', '057');

    assert.equal(
        calls[0].url,
        'https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=057'
    );
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);

    const hostile = recordingFetch(() => fakeResponse({ status: true, data: {} }));
    const hostileClient = createPaystackTransferClient(hostile.fetchImpl);
    await hostileClient.resolveAccount('12&x=1', '057/../../transfer');

    assert.equal(
        hostile.calls[0].url,
        'https://api.paystack.co/bank/resolve?account_number=12%26x%3D1&bank_code=057%2F..%2F..%2Ftransfer'
    );
    assert.equal(hostile.calls[0].url.split('?')[1].split('&').length, 2);
});

test('a non-2xx body is reduced to sanitized provider details', async () => {
    const { fetchImpl } = recordingFetch(() =>
        fakeResponse(
            {
                status: false,
                message:
                    'Could not resolve 0123456789 for user@example.test using sk_test_LEAK123 and Bearer LEAK456',
                type: 'invalid_params',
            },
            { ok: false, status: 400 }
        )
    );
    const client = createPaystackTransferClient(fetchImpl);

    await assert.rejects(
        () =>
            client.createRecipient({
                type: 'nuban',
                name: 'Ada Employee',
                account_number: '0123456789',
                bank_code: '057',
                currency: 'NGN',
            }),
        (error) => {
            assert.ok(error instanceof PaystackHttpError);
            assert.equal(error.statusCode, 400);
            assert.equal(error.operation, 'createRecipient');
            assert.equal(error.providerErrorType, 'invalid_params');
            assert.match(error.providerMessage, /\[redacted\]/);

            const surfaces = [
                error.message,
                error.providerMessage,
                JSON.stringify(error),
                error.stack,
            ];
            for (const surface of surfaces) {
                assert.equal(surface.includes('LEAK123'), false);
                assert.equal(surface.includes('LEAK456'), false);
                assert.equal(surface.includes('user@example.test'), false);
                assert.equal(surface.includes('0123456789'), false);
            }
            return true;
        }
    );
});

test('a malformed non-2xx body adds no provider text and still keeps the status', async () => {
    const { fetchImpl } = recordingFetch(() =>
        fakeResponse('not json', { ok: false, status: 502 })
    );
    const client = createPaystackTransferClient(fetchImpl);

    await assert.rejects(
        () => client.listBanks(),
        (error) => {
            assert.equal(error.statusCode, 502);
            assert.equal(error.operation, 'listBanks');
            assert.equal(error.providerMessage, undefined);
            assert.equal(error.providerErrorType, undefined);
            return true;
        }
    );
});
