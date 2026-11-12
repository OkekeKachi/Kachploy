var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var jobsRouter = require('./routes/jobs');
var applicationsRouter = require('./routes/applications');
var tasksRouter = require('./routes/tasks');
// STAGE 7A: the employments resource. Read-only router; the create happens
// inside the hire flow (PUT /applications/:id/status), not behind a route.
var employmentsRouter = require('./routes/employments');
// STAGE 7C: the interviews resource. The create and update routes are
// employer-only; reads are open to either party to the application.
var interviewsRouter = require('./routes/interviews');
// STAGE 8B: the chat resource. Every route is open to either participant on the
// conversation -- the applicant or the employer who posted the job -- and the
// router's two guards decide which callers those are.
var conversationsRouter = require('./routes/conversations');
// STAGE P1: the contracts resource. Create by the employer on an active
// employment, accept by the employee, and two party-scoped reads. It records
// agreed prices and acceptance only -- it does not charge, hold, payout or escrow.
var contractsRouter = require('./routes/contracts');
// STAGE P2: the payments resource. Local payment RECORDS only -- an employer
// storing a payment request for one approved milestone of an active contract.
// It contacts no provider, moves no money, and makes no escrow/payout claim.
var paymentsRouter = require('./routes/payments');
var releasesRouter = require('./routes/releases');
// Disputes and reviews
var disputesAndReviewsRouter = require('./routes/disputesAndReviews');
// STAGE 1: the admin review queue. Every route behind protect + requireAdmin,
// authorised by the `admin === true` custom claim only.
var adminRouter = require('./routes/admin');
// STAGE 1L: the Paystack webhook. A provider-to-server callback, authenticated
// by an HMAC SHA-512 signature over the raw body rather than a bearer token, so
// it is mounted outside the token-protected payments router.
var paystackWebhookRouter = require('./routes/paystackWebhook');
// STAGE 1M: liveness (`GET /health`) and readiness (`GET /ready`) probes. Public
// by design -- see controllers/healthController.js -- and mounted at the root.
var healthRouter = require('./routes/health');
// STAGE 1M: CORS origin allowlist. Empty CORS_ORIGINS preserves the previous
// reflect-any-origin behaviour, so development and every existing test are
// unchanged unless an operator opts in.
const { getCorsOptions } = require('./config/cors');
const { getSecurityConfig } = require('./config/security');
const { generalRateLimiter } = require('./middleware/rateLimit');


var app = express();
const securityConfig = getSecurityConfig();

app.set('trust proxy', securityConfig.trustProxy);
app.disable('x-powered-by');

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(helmet());
app.use(cors(getCorsOptions()));
app.use(logger('dev'));
// STAGE 1L. The parsed body is unchanged for every route; the `verify`
// callback additionally preserves the EXACT raw request bytes on req.rawBody.
// The Paystack webhook must HMAC the byte-for-byte payload the provider sent,
// and re-serializing the parsed JSON would not reproduce those bytes (key
// order, whitespace and number formatting are all lost). Only Buffer data is
// stored; a request with no body leaves req.rawBody undefined.
app.use(
  express.json({
    limit: securityConfig.requestBodyLimit,
    verify: (req, res, buf) => {
      if (Buffer.isBuffer(buf)) {
        req.rawBody = buf;
      }
    },
  })
);
app.use(
  express.urlencoded({
    extended: false,
    limit: securityConfig.urlencodedBodyLimit,
  })
);
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// STAGE 1M: mounted before every feature router and before the 404 catch-all so
// the two conventional probe paths always resolve. The router declares the full
// `/health` and `/ready` paths itself, hence the root mount.
app.use('/', healthRouter);
app.use(generalRateLimiter);
app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/applications', applicationsRouter);
app.use('/jobs', jobsRouter);
app.use('/tasks', tasksRouter);
app.use('/employments', employmentsRouter);
app.use('/interviews', interviewsRouter);
app.use('/conversations', conversationsRouter);
app.use('/contracts', contractsRouter);
app.use('/', disputesAndReviewsRouter);
app.use('/admin', adminRouter);
// STAGE 1L: mounted BEFORE the payments router so POST /payments/webhook can
// never be shadowed by a future /payments route; the webhook path is fixed.
app.use('/payments/webhook', paystackWebhookRouter);
app.use('/payments', paymentsRouter);
app.use('/releases', releasesRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
//
// STAGE 1M. Two behaviours, chosen by environment, because a development stack
// trace and a production stack trace have opposite value: the first is the
// fastest way to debug, the second hands an attacker the internal shape of the
// server.
//
// DEVELOPMENT (`app.get('env') !== 'production'`): unchanged from the original
// generated handler -- the Jade error page renders `err.message`, the status and
// the full stack. Every existing test runs here (the harness sets no NODE_ENV),
// so their assertions on the HTML error page keep holding.
//
// PRODUCTION: no view, no stack, no internal message. The response is JSON,
// because every real API error on this server is JSON and a monitoring client
// should not have to parse HTML. A 5xx is answered with a fixed generic string
// -- NOT `err.message` -- so a thrown database or provider error cannot describe
// itself to the caller. A 4xx keeps `err.message` only when the error carries an
// explicit `expose` flag (http-errors sets it for client-safe errors like the 400
// from the JSON body parser); otherwise it is generic too. The FULL error is still
// written to the server log in every environment, so operational visibility is
// kept while the client response is redacted.
app.use(function(err, req, res, next) {
  const isProduction = req.app.get('env') === 'production';
  const status = err.status || err.statusCode || 500;

  // Server-side log. Always the full error, never the response. This is the only
  // place the stack is kept in production.
  if (status >= 500) {
    console.error(err);
  }

  if (!isProduction) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(status);
    return res.render('error');
  }

  // Production: generic message unless the error is explicitly client-safe.
  const message = err.expose && err.message ? err.message : 'Internal Server Error';

  res.status(status).json({ message });
});

module.exports = app;
