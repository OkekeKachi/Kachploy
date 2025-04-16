// firebase.js
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';



const firebaseConfig = {
    // apiKey: "AIzaSyAgmogR5paYl04UR71FNgvSgaQXxFU3V4c",
    // authDomain: "social-media-2f8e1.firebaseapp.com",
    // databaseURL: "https://social-media-2f8e1-default-rtdb.firebaseio.com",
    // projectId: "social-media-2f8e1",
    // storageBucket: "social-media-2f8e1.appspot.com",
    // messagingSenderId: "319658697915",
    // appId: "1:319658697915:web:0556303b37b6ddc52ab59e",
    // measurementId: "G-YN9EPQW876"

    // apiKey: "AIzaSyDGFjACqu_Gvy7aXs4yR5DC0wSNKU_EFco",
    // authDomain: "bookme-a2176.firebaseapp.com",
    // databaseURL: "https://bookme-a2176-default-rtdb.firebaseio.com",
    // projectId: "bookme-a2176",
    // storageBucket: "bookme-a2176.firebasestorage.app",
    // messagingSenderId: "111533919629",
    // appId: "1:111533919629:web:439f963430a4138e8541c4",
    // measurementId: "G-LLN8P5M1YS"


    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,

};



const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);