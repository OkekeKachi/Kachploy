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
  const { fullName, phone, role, profileComplete } = req.body;

  // Add the same formatting function as your frontend
  const formatPhoneNumber = (phone) => {
    if (!phone) return phone;

    const digits = phone.replace(/\D/g, '');

    if (digits.length === 10) {
      return `+234${digits}`;
    } else if (digits.length === 11 && digits.startsWith('0')) {
      return `+234${digits.substring(1)}`;
    } else if (digits.length === 13 && digits.startsWith('234')) {
      return `+${digits}`;
    } else if (phone.startsWith('+')) {
      return phone;
    }

    return phone;
  };

  try {
    const userRef = db.collection("users").doc(uid);
    const doc = await userRef.get();

    if (!doc.exists) {
      await admin.auth().updateUser(uid, {
        displayName: fullName,
        phoneNumber: formatPhoneNumber(phone), // Format phone here too!
      });

      await userRef.set({
        role,
        profileComplete,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("✅ User registered and profile updated");
    } else {
      console.log("👤 User already exists");
      return res.status(200).send("User already registered");
    }

    res.status(200).send("User registered successfully");
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).send("Error registering user");
  }
});

// router.get('/profile', async (req, res) => {
//   try {
//     const idToken = req.headers.authorization?.split(' ')[1];
//     const decodedToken = await admin.auth().verifyIdToken(idToken);
//     const uid = decodedToken.uid;

//     // Fetch from Firestore or your own DB
//     const userDoc = await db.collection('users').doc(uid).get();
//     if (!userDoc.exists) return res.status(404).send("User not found");

//     res.json(userDoc.data());
//   } catch (err) {
//     console.error(err);
//     res.status(401).send("Unauthorized");
//   }
// });

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
router.get('/getUser/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Fetch user from Firestore
    const userRef = admin.firestore().collection('users').doc(userId);
    const doc = await userRef.get();

    // Check if user exists
    if (!doc.exists) {
      return res.status(404).send('User not found');
    }

    const user = doc.data();  // Get user data
    console.log(user);

    
    res.json({ user: user });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).send('Server error');
  }
});

router.put('/update/:uid', async (req, res) => {
  const { uid } = req.params;
  const userData = req.body;

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Extract profilePic from userData to update Auth user
    const { profilePic, ...firestoreData } = userData;

    // Update Firebase Auth user profile if profilePic is provided
    if (profilePic) {
      await admin.auth().updateUser(uid, {
        photoURL: profilePic,
      });
    }

    // Update Firestore document (excluding profilePic since it's now in Auth)
    await userRef.update(firestoreData);

    res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});




module.exports = router;



