'use strict';

/**
 * STAGE 10G.1. Cloudinary credentials and signed-upload signatures, server-side only.
 *
 * This is the counterpart of config/firebase.js for the one thing Stage 10G.1 changes:
 * where a task submission file is stored. The upload itself still travels from the
 * employee's browser straight to the storage provider and never through this API --
 * what moved is that the browser may only upload under a path THIS server signed.
 *
 * THREE REQUIRED ENVIRONMENT VARIABLES, READ HERE AND NOWHERE ELSE:
 *
 *   CLOUDINARY_CLOUD_NAME       which cloud the signature is for
 *   CLOUDINARY_API_KEY          sent to Cloudinary with the upload
 *   CLOUDINARY_API_SECRET       used to sign, and NEVER leaves this process
 *   CLOUDINARY_FOLDER_PREFIX    optional deployment namespace, prepended to every folder
 *
 * The secret does not appear in the response, in a log line, or in the signature
 * itself: the signature is a SHA-1 over the signed parameters plus the secret
 * (cloudinary.utils.api_sign_request), which is the standard Cloudinary scheme and
 * is one-way. The client receives only what it needs to make the request --
 * cloud name, api key, timestamp, signature and the path that was signed.
 *
 * WHY THE ENV IS READ LAZILY, ON EVERY CALL. config/firebase.js reads its credentials
 * once, at require time, because a missing service-account is a fatal error for the
 * whole server. Credentials here are different: signing is a small feature, the server
 * is perfectly usable without it (text and link submissions never touch Cloudinary),
 * and tests need to exercise the unconfigured case. So the environment is re-read on
 * each signature and an absent or partial configuration raises
 * CloudinaryConfigurationError, which the controller answers with a 503 rather than
 * letting an undefined property reach a 500. The `.env` file is gitignored, so an
 * unconfigured deployment is the normal state for a fresh clone.
 *
 * Nothing in this module opens a network connection. Signing is local arithmetic; the
 * only call that would reach Cloudinary is an upload, which the browser makes directly
 * with the credentials returned below.
 */

const { v2: cloudinary } = require('cloudinary');

// Listed rather than read inline so the failure message can name the whole set: a
// partially configured server (cloud name and key, no secret) would otherwise look
// like a typo in whichever variable happened to be checked first.
const CREDENTIAL_VARS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const FOLDER_PREFIX_ENV_VAR = 'CLOUDINARY_FOLDER_PREFIX';
const FOLDER_PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Raised when a signature is requested and the environment is not complete.
 *
 * Carries a code rather than relying on `instanceof` alone so a controller can match
 * it across the require boundary -- and so the message, which names environment
 * variables and nothing else, is the only thing that could ever reach a client. It
 * deliberately does NOT say which of the three is missing: that is a deployment
 * detail for the server log, not for an unauthenticated-adjacent response.
 */
class CloudinaryConfigurationError extends Error {
    constructor(
        message = `Cloudinary upload signing is not configured: set ${CREDENTIAL_VARS.join(', ')}`,
        code = 'CLOUDINARY_NOT_CONFIGURED'
    ) {
        super(message);
        this.name = 'CloudinaryConfigurationError';
        this.code = code;
    }
}

/**
 * The three values, or null when any of them is absent or blank.
 *
 * Blank counts as absent. `.env` files accumulate `CLOUDINARY_API_KEY=` lines when a
 * value is cleared out, and an empty string would otherwise sign successfully-looking
 * payloads with an empty secret, which is worse than refusing: it produces a
 * signature Cloudinary rejects with a far less useful error.
 */
const readCredentials = () => {
    const [cloudName, apiKey, apiSecret] = CREDENTIAL_VARS.map((name) => {
        const value = process.env[name];
        return typeof value === 'string' ? value.trim() : '';
    });

    if (!cloudName || !apiKey || !apiSecret) return null;

    return { cloudName, apiKey, apiSecret };
};

/** Whether this server can sign uploads at all. Used by nothing but the tests. */
const isConfigured = () => readCredentials() !== null;

const readFolderPrefix = (value) => {
    if (value === undefined || value === null) return '';

    if (typeof value !== 'string') {
        throw new CloudinaryConfigurationError(
            `${FOLDER_PREFIX_ENV_VAR} must be a string`,
            'CLOUDINARY_FOLDER_PREFIX_INVALID'
        );
    }

    const normalized = value.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) return '';

    const segments = normalized.split('/');
    if (segments.some((segment) => !FOLDER_PREFIX_SEGMENT_PATTERN.test(segment))) {
        throw new CloudinaryConfigurationError(
            `${FOLDER_PREFIX_ENV_VAR} must be a slash-separated path using letters, numbers, dots, underscores or hyphens`,
            'CLOUDINARY_FOLDER_PREFIX_INVALID'
        );
    }

    return segments.join('/');
};

const getFolderPrefix = () => readFolderPrefix(process.env[FOLDER_PREFIX_ENV_VAR]);

const qualifyFolder = (folder) => {
    if (typeof folder !== 'string' || folder.trim() === '') {
        throw new TypeError('Cloudinary folder must be a non-empty string');
    }

    const normalized = folder.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized.includes('..')) {
        throw new CloudinaryConfigurationError(
            'Cloudinary folder must be a non-empty path without traversal segments',
            'CLOUDINARY_FOLDER_INVALID'
        );
    }

    const prefix = getFolderPrefix();
    return prefix ? `${prefix}/${normalized}` : normalized;
};

/**
 * Signs a set of upload parameters for one direct-to-Cloudinary upload.
 *
 * `params` are exactly the non-file fields the browser will post alongside the file --
 * for a task submission, the server-chosen `folder` and `public_id`. They are signed
 * here so that changing either of them in flight invalidates the signature, which is
 * what stops a client from asking for a signature for one task and uploading into
 * another: the path is chosen by the caller of this function (taskService, from the
 * task's own id) and the client cannot rewrite it without recomputing a signature it
 * has no way to compute.
 *
 * The timestamp is minted here rather than accepted as an argument, for the same
 * reason. It is part of the signature, so a caller cannot reuse a signature with an
 * old timestamp, and Cloudinary rejects signatures whose timestamp has drifted too
 * far from its own clock.
 *
 * Returns only what the browser needs. The api secret is used and not returned, and
 * no other field of the process environment is read here.
 */
const signUploadRequest = (params = {}) => {
    const credentials = readCredentials();

    if (!credentials) throw new CloudinaryConfigurationError();

    // Configures the SDK for anything else that might use it later (an admin call to
    // check an asset, say). The signature below passes the secret explicitly, so
    // signing does not depend on this having happened -- it is not a hidden
    // prerequisite, and no secret is captured at module load.
    cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request({ ...params, timestamp }, credentials.apiSecret);

    return {
        cloudName: credentials.cloudName,
        apiKey: credentials.apiKey,
        timestamp,
        signature,
    };
};

/**
 * STAGE 12.12. Generates a short-lived signed download URL for a private asset.
 * Uses Cloudinary's `private_download_url` helper. The `format` may be null to
 * let Cloudinary infer the extension; the expiry is in seconds.
 *
 * BOTH the resource class AND the storage type must be sent, because the admin
 * `/download` endpoint addresses an asset by the pair -- `resource_type` AND
 * `type`, defaulting each independently. `resourceType` MUST name the class the
 * asset was uploaded as: a resume is uploaded as `raw` (userService.RESUME_RESOURCE_TYPE),
 * and the SDK's `private_download_url` builds its URL through `api_url`, which
 * falls back to `image` when no `resource_type` is given. Asking the image
 * namespace for a raw asset is answered with "Resource not found" even though the
 * file exists, so the default here is `raw`.
 *
 * `type` MUST be sent too. The upload path signs and stores resumes as
 * type `upload` (the SDK default on upload), but the download endpoint does NOT
 * default to `upload`: with no `type` in the signed parameters it looks up a
 * different storage class (`private`/`authenticated`) and answers "Resource not
 * found" for an asset that clearly exists -- the exact coordinate
 * verifyUploadedAsset already proves by passing `type: 'upload'`. Omitting it is
 * why a stored resume 404s on download despite existing as raw/upload. The
 * default is therefore `upload`, matching every write path.
 *
 * The `public_id` is used verbatim -- it already carries the folder and, for a raw
 * upload, the format extension -- so no folder is prepended and no `.pdf` is
 * appended.
 */
const generateSignedDownloadUrl = (publicId, { expiresInSeconds = 300, resourceType = 'raw', type = 'upload' } = {}) => {
    const credentials = readCredentials();
    if (!credentials) throw new CloudinaryConfigurationError();

    cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
    });

    return cloudinary.utils.private_download_url(publicId, null, {
        resource_type: resourceType,
        type,
        expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
};

/**
 * STAGE 12.13. Confirms that a client-supplied private asset actually exists in
 * Cloudinary before a reference to it is trusted.
 *
 * WRITE-SIDE ONLY. This is called when a resume reference is about to be
 * persisted -- on an application (applicationService.applyToJob) and on a
 * profile (userService.updateUserProfile) -- never on the download path, which
 * must keep serving references already stored.
 *
 * It answers one question with one admin API call: does this public id name a
 * real, already-uploaded asset of this resource class? A reference that passes
 * the services' own shape checks can still name nothing at all -- an id minted
 * by hand, or one from a different cloud -- and storing it would produce a
 * download that 404s long after the caller is gone. The ownership check (that
 * the id sits under the caller's own folder) lives in the services, which know
 * the caller's id; this function only knows the id to look up. See the comment
 * on signUploadRequest above: the SDK configuration this reuses is the same one.
 *
 * Returns true when the asset is found. Returns false -- and never throws for
 * this -- when Cloudinary reports the asset missing (its 404, or a 400 for a
 * malformed id), so the caller raises its own validation error with its own
 * wording. Anything else (a network failure, a rejected credential) propagates:
 * that is a server fault, not a bad reference.
 *
 * Throws CloudinaryConfigurationError when the environment is incomplete, the
 * same contract as the signer and the download URL helper.
 */
const verifyUploadedAsset = async (publicId, { resourceType = 'raw' } = {}) => {
    if (typeof publicId !== 'string' || publicId.trim() === '') return false;

    const credentials = readCredentials();
    if (!credentials) throw new CloudinaryConfigurationError();

    cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
    });

    try {
        await cloudinary.api.resource(publicId, { resource_type: resourceType, type: 'upload' });
        return true;
    } catch (error) {
        if (error && (error.http_code === 404 || error.http_code === 400)) {
            return false;
        }

        throw error;
    }
};

/**
 * STAGE 12.14. Deletes one previously-uploaded asset from Cloudinary.
 *
 * The counterpart of verifyUploadedAsset for the one operation that MUTATES
 * Cloudinary state rather than reading or signing it. It exists so a replaced
 * profile photo does not accumulate in the media library.
 *
 * Server-side only. The api secret is read here (readCredentials) and never
 * returned. `publicId` must already have been proven to belong to the caller by
 * the service layer -- this helper deletes whatever it is given, so
 * userService.deleteReplacedProfilePhoto only ever passes an id read from that
 * user's own stored profile and re-checked against `profilePics/{uid}/`. No value
 * from a request ever reaches here.
 *
 * `resourceType` and `type` address the asset by the pair Cloudinary stores it
 * under, the same coordinates verifyUploadedAsset proves with and every upload
 * path writes with -- `image`/`upload` for a profile photo, `raw`/`upload` for a
 * resume. Returns the SDK's result on success. Throws CloudinaryConfigurationError
 * when the environment is incomplete, and propagates any Cloudinary/network error:
 * the CALLER decides whether that is fatal, because a cleanup failure must not turn
 * an already-committed profile update into an error the user sees.
 */
const deleteUploadedAsset = async (publicId, { resourceType = 'image', type = 'upload' } = {}) => {
    if (typeof publicId !== 'string' || publicId.trim() === '') {
        throw new Error('deleteUploadedAsset requires a public id');
    }

    const credentials = readCredentials();
    if (!credentials) throw new CloudinaryConfigurationError();

    cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
    });

    return cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type });
};

module.exports = {
    cloudinary,
    CloudinaryConfigurationError,
    CREDENTIAL_VARS,
    FOLDER_PREFIX_ENV_VAR,
    isConfigured,
    getFolderPrefix,
    qualifyFolder,
    signUploadRequest,
    generateSignedDownloadUrl,
    verifyUploadedAsset,
    deleteUploadedAsset,
};
