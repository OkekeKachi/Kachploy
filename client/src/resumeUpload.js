// resumeUpload.js
//
// The one place a resume is uploaded to, and downloaded from, Cloudinary. Shared
// by the profile editor (pages/Profile.jsx), the application form
// (pages/JobDetails.jsx) and the two application lists, so the flows cannot
// drift. It is the resume counterpart of profilePhotoUpload.js and keeps the
// same three-step shape:
//
//   1. POST /users/resume/signature -- authenticated, `protect`-only on the
//      server, answered with `{ cloudName, apiKey, timestamp, signature, folder,
//      publicId, resourceType, allowedFormats }`. The caller sends no user id:
//      the server builds `resumes/{uid}` from the verified token, so the
//      signature is only ever good for the caller's own folder.
//
//   2. The upload: a multipart POST to
//      https://api.cloudinary.com/v1_1/{cloud}/{resourceType}/upload carrying the
//      file and exactly the parameters the server signed. `resource_type` selects
//      the endpoint, and `allowed_formats` must be echoed unchanged because the
//      server signed it.
//
//   3. Cloudinary answers with the stored asset. THIS MODULE DELIBERATELY RETURNS
//      ONLY THE PRIVATE REFERENCE -- `{ publicId, name, resourceType }` -- and
//      never `secure_url`. A resume must not be reachable by an unauthenticated
//      URL, so no public URL is ever read off the response or handed to a caller
//      to persist. Delivery is through the server's signed-download endpoints.
//
// WHY THE FILE IS CHECKED HERE. The bytes go browser -> Cloudinary and never pass
// through the server, so the PDF-only rule and the size limit are enforced here
// (by MIME type and extension, before any request) and the format again by
// Cloudinary (the `raw` resource type plus the signed `allowed_formats`). A
// rejection never yields a reference, so the caller's existing error handling
// decides what the user sees and never overwrites a stored resume.
import api from './api';

/**
 * The largest resume this app will upload, in bytes.
 *
 * A resume is a small document; 5 MB matches the image limit and keeps the
 * multipart body small. Cloudinary's account limit is the server-side backstop;
 * this is the check that keeps an oversized file from leaving the browser.
 */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/** True for a PDF by MIME type or by extension (some browsers send neither). */
const isPdf = (file) =>
    file &&
    (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));

/**
 * Uploads one PDF and resolves with its private reference
 * `{ publicId, name, resourceType }`.
 *
 * Rejects (throws) without uploading when the file is missing, is not a PDF, or
 * exceeds MAX_RESUME_BYTES, and surfaces Cloudinary's own `error.message` when it
 * refuses the upload. Never resolves to a `secure_url` or any other public URL.
 */
export async function uploadResume(file) {
    if (!isPdf(file)) {
        throw new Error('Please choose a PDF file.');
    }

    if (file.size > MAX_RESUME_BYTES) {
        throw new Error('That file is too large. Please choose one under 5 MB.');
    }

    const signed = await api.post('/users/resume/signature');
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

    // For a `raw` upload Cloudinary returns the stored id under `public_id`, with
    // the folder and the `.pdf` extension already included. The private reference
    // is built from it; `secure_url` is intentionally ignored.
    if (!result.public_id) {
        throw new Error('the upload response did not include a file id');
    }

    return {
        publicId: result.public_id,
        name: file.name || 'resume.pdf',
        resourceType: resourceType || 'raw',
    };
}

/**
 * Fetches a short-lived signed download URL for a stored resume and opens it.
 *
 *   downloadResume()                       -> the caller's own profile resume
 *   downloadResume({ applicationId })      -> one application's resume
 *
 * The asset id is never sent: the server reads it from the caller's own record
 * or from the application it is authorized to see, so a caller cannot name a
 * file. Resolves with the `{ url, name }` the server returned after opening it.
 */
export async function downloadResume({ applicationId } = {}) {
    const path = applicationId
        ? `/applications/${applicationId}/resume/download`
        : '/users/resume/download';

    const res = await api.get(path);
    const { url, name } = res.data;

    // An anchor click rather than window.open: it opens in a new tab from a user
    // gesture without being treated as a popup, and the signed URL is never
    // rendered into the page.
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = name || '';
    document.body.appendChild(link);
    link.click();
    link.remove();

    return res.data;
}
