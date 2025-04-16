const admin = require("firebase-admin");
// const serviceAccount = require("./social-media-2f8e1-firebase-adminsdk-36y0k-9cf4b00b5e.json");
// const serviceAccount = require("./bookme-a2176-firebase-adminsdk-fbsvc-5c3ad8bdf1.json");
const serviceAccount = require("./pet-idea-firebase-adminsdk-gc05a-d562d86349.json")

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = { admin, db };
