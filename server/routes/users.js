var express = require('express');
var router = express.Router();

const { admin, db } = require("../config/firebase");

// 🔐 Middleware to verify token
const verifyToken = async (req, res, next) => {
  
  
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send("Unauthorized");
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    console.log("working");
    
    next();
    
  } catch (error) {
    res.status(401).send("Invalid token");
  }
};

/* GET users listing. */
router.get('/', function (req, res, next) {
  res.send('responds with a resource');
});




router.post("/register", verifyToken, async (req, res) => {
  const { uid, email } = req.user;
  const { fullName, phone, role } = req.body;

  try {
    const userRef = db.collection("users").doc(uid);
    const doc = await userRef.get();

    if (!doc.exists) {
      await userRef.set({
        email,
        fullName,
        phone,
        role,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      console.log("👤 User already exists");
      return res.status(200).send("User already registered");
    }

    // Optionally trigger OTP or email verification here

    res.status(200).send("User registered in DB");
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).send("Error registering user");
  }
});

router.get('/profile', async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split(' ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // Fetch from Firestore or your own DB
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).send("User not found");

    res.json(userDoc.data());
  } catch (err) {
    console.error(err);
    res.status(401).send("Unauthorized");
  }
});

router.post('/register-profile', verifyToken, async (req, res) => {
  const { uid, email } = req.user;
  const { fullName, phone, location, serviceType, bio } = req.body;

  try {
    await db.collection('users').doc(uid).set({
      email, uid, fullName, phone, location, serviceType, bio,
      isProfileComplete: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(200).send("✅ Profile saved!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error saving profile");
  }
});

module.exports = router;



