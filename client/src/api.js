// api.js
//
// Shared axios instance that attaches the Firebase ID token to every request.
//
// The server requires `Authorization: Bearer <id-token>` on all 21 routes
// (see server/test/docs/ENDPOINTS.md). Before this module each page called the
// global `axios` directly with a hardcoded origin and no token, so nearly every
// request was rejected with 401.
//
// All 31 frontend call sites now use this instance. Pages import it as
// `import api from '../api';` and pass bare paths, which resolve against
// baseURL below:
//
//   import api from '../api';
//   const res = await api.get('/jobs');
//
// If you add a call site, use `api`, not the bare `axios` import.

import axios from 'axios';
import { auth } from './firebase';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;

  // No signed-in user: send the request unauthenticated and let the server
  // decide. This keeps public reads and the sign-up flow working.
  if (!user) return config;

  try {
    // getIdToken() returns the cached token when still valid and transparently
    // refreshes it when expired, so this is both cheap and always current.
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  } catch (err) {
    // A failed token fetch must not silently fall back to an anonymous request;
    // the resulting 401 is easier to diagnose than a missing header.
    console.error('Could not attach ID token to request', err);
  }

  return config;
});

export default api;
