// profilePhotoUpload.js
//
// The one place a profile photo is uploaded to Cloudinary. Shared by the profile
// editor (pages/Profile.jsx) and the onboarding form (pages/completeProfile.jsx)
// so the two cannot drift into two different upload flows -- the same reasoning
// components/TaskCard.jsx records for owning the task-file upload on its own.
//
// THE THREE STEPS, AND WHAT EACH ONE CAN TAKE WITH IT:
//
//   1. POST /users/profile-photo/signature -- authenticated, `protect`-only on the
//      server, answered with `{ cloudName, apiKey, timestamp, signature, folder,
//      publicId, resourceType, allowedFormats }`. The caller sends no user id: the
//      server builds `profilePics/{uid}` from the verified token, so the signature
//      is only ever good for the caller's own folder. A failure here uploads
//      nothing and leaves the existing photo untouched.
//
//   2. The upload: a multipart POST to
//      https://api.cloudinary.com/v1_1/{cloud}/{resourceType}/upload carrying the
//      file and exactly the parameters the server signed. This is the only network
//      call in the flow that does not go to this app's API, and it is why the api
//      secret must never reach the page: the signature grants this one upload and
//      is useless for any other. `resource_type` selects the endpoint rather than
//      being sent as a field, and `allowed_formats` must be sent unchanged because
//      the server signed it -- Cloudinary rejects a request whose parameters do not
//      match the signature.
//
//   3. Cloudinary answers with `secure_url` and `public_id`. Both are returned to
//      the caller. The URL is stored as `profilePic` through the existing
//      PUT /users/update/:uid flow; the public id is sent back in the same request
//      as `profilePicPublicId` so the server can delete the photo this upload
//      REPLACES. The id is not a secret -- it is embedded in the delivery URL --
//      and the server checks it against the caller's own folder before any delete.
//
// WHY THE FILE IS CHECKED HERE. In this sign-then-upload architecture the bytes go
// browser -> Cloudinary and never pass through the server, so a size limit can only
// be enforced in the browser, and the format is enforced twice: here (by MIME type,
// before any request) and by Cloudinary (the `image` resource type plus the signed
// `allowed_formats`). The error thrown here or returned by Cloudinary is the
// caller's to surface; a failure never yields a URL, so the caller's existing
// error handling decides what the user sees and never overwrites the stored photo.
import api from './api';

/**
 * The largest image this app will upload, in bytes.
 *
 * Matches the 5 MB Android profile-photo limit and keeps the base64-free multipart
 * body small. Cloudinary's own account limit is the server-side backstop; this is
 * the check that keeps an oversized file from ever leaving the browser.
 */
export const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * Uploads one image file and resolves with `{ url, publicId }` for the stored
 * asset.
 *
 * `url` is the Cloudinary `secure_url`. `publicId` is the id Cloudinary assigned
 * to it, which the caller passes back through PUT /users/update/:uid as
 * `profilePicPublicId` so the server can clean up the photo this upload replaces.
 * The id is not a secret -- it is part of the delivery URL -- but it is the only
 * handle the server accepts for a deletion, and it is validated against the
 * caller's own folder before use.
 *
 * Rejects (throws) without uploading when the file is missing, is not an image, or
 * exceeds MAX_PROFILE_PHOTO_BYTES, and surfaces Cloudinary's own `error.message`
 * when it refuses the upload. Never resolves to an empty value: the caller can
 * treat a resolved `url` as a real upload and a rejection as "nothing changed".
 */
export async function uploadProfilePhoto(file) {
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
        throw new Error('Please choose an image file (JPG, PNG or WebP).');
    }

    if (file.size > MAX_PROFILE_PHOTO_BYTES) {
        throw new Error('That image is too large. Please choose one under 5 MB.');
    }

    const signed = await api.post('/users/profile-photo/signature');
    const {
        cloudName,
        apiKey,
        timestamp,
        signature,
        folder,
        publicId,
        resourceType,
        allowedFormats,
    } = signed.data;

    const form = new FormData();
    form.append('file', file);
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('signature', signature);
    form.append('folder', folder);
    form.append('public_id', publicId);
    form.append('allowed_formats', allowedFormats);

    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;
    const response = await fetch(uploadUrl, { method: 'POST', body: form });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.error) {
        throw new Error(
            (result && result.error && result.error.message) || `the upload failed (${response.status})`
        );
    }

    if (!result.secure_url) {
        throw new Error('the upload response did not include an image URL');
    }

    // Cloudinary echoes the public id it stored the asset under. This is the value
    // the server needs to delete the asset later; an absent one simply means no
    // public id is sent, and the server falls back to deriving it from the URL.
    const uploadedPublicId = typeof result.public_id === 'string' ? result.public_id : '';

    return { url: result.secure_url, publicId: uploadedPublicId };
}
