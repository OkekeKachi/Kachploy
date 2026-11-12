'use strict';

// routes/health.js (STAGE 1M)
//
// Infrastructure endpoints, mounted with NO auth middleware on purpose. See
// controllers/healthController.js for why they are public and what they may
// return. Two routes only:
//
//   GET /health   liveness  (always 200 while the process lives)
//   GET /ready    readiness (200 ready / 503 not-ready, from configuration)
//
// The router is mounted at the app root with the two full paths spelled here,
// rather than mounted AT `/health`, so the conventional `/ready` path is also
// available. Neither route reads a request body or a query parameter, so
// nothing caller-supplied reaches the handlers.

const express = require('express');
const router = express.Router();

const { getHealth, getReady } = require('../controllers/healthController');

router.get('/health', getHealth);
router.get('/ready', getReady);

module.exports = router;
