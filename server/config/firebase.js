const admin = require("firebase-admin");
const path = require("path");

// Resolve the service‑account path:
// * If FIREBASE_SERVICE_ACCOUNT_PATH is set (even if empty), honour it.
// * If it is unset or explicitly empty, fall back to the default credential.
let serviceAccountPath;
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH !== undefined) {
    // Variable is set – treat an empty value as an explicit error.
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH.trim() === '') {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH must not be empty');
    }
    serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
} else {
    // Not set – use the bundled default.
    serviceAccountPath = path.resolve(__dirname, "./pet-idea-firebase-adminsdk-gc05a-d562d86349.json");
}

// Validate that the file exists and is readable before requiring it.
let serviceAccount;
try {
    const fs = require("fs");
    if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(
            `Firebase service‑account file not found at ${serviceAccountPath}. ` +
            `Set FIREBASE_SERVICE_ACCOUNT_PATH to a valid path or ensure the default file exists.`
        );
    }
    serviceAccount = require(serviceAccountPath);
} catch (e) {
    throw new Error(
        `Firebase initialization failed: could not load service‑account JSON from ${serviceAccountPath}. ${e.message}`
    );
}

// Initialize the Admin SDK using the explicit service‑account credential.
// This guarantees the Admin SDK uses the pet‑idea project, matching the
// client firebase.js config (VITE_FIREBASE_PROJECT_ID=pet‑idea).
let app;
try {
    app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    // Re‑throw with a clear message if the service‑account file is invalid.
    throw new Error(
        'Firebase initialization failed: could not initialize with the provided service‑account JSON.'
    );
}

const db = admin.firestore();

module.exports = { admin: admin, app, db };