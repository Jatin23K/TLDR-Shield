import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Firebase client config — these values are public by Firebase design.
// They identify the project but do not grant access on their own.
// The actual secret (service account private key) lives in
// FIREBASE_SERVICE_ACCOUNT_JSON env var on the server only.
const firebaseConfig = {
  projectId:           'gen-lang-client-0199678316',
  appId:               '1:292798741977:web:0c4b85c8c5d1064f6c6dc8',
  apiKey:              'AIzaSyBK9FHFwFC_qDdoRCxLzuCmyEV4sTqzhiY',
  authDomain:          'gen-lang-client-0199678316.firebaseapp.com',
  storageBucket:       'gen-lang-client-0199678316.firebasestorage.app',
  messagingSenderId:   '292798741977',
  firestoreDatabaseId: 'ai-studio-ab2f680c-4045-42d2-9306-ee0a1281b5ad',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export const signIn = () => signInWithPopup(auth, googleProvider);
export const signOut = () => auth.signOut();
