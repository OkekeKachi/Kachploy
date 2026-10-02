// employmentController.js
//
// HTTP layer for the employments resource (new in Stage 7A). Two Express
// handlers, each doing only the three things every controller in this codebase
// does: read the request, call exactly one employmentService function, and
// translate the outcome into a status code and body.
//
// There is no create handler, and that is the design rather than an omission. An
// employment exists only as the consequence of a hire, and the hire is performed
// by PUT /applications/:id/status; this resource has no POST of its own, so a
// client cannot manufacture one. See services/employmentService.js for why.
//
// Both handlers respond `{ employments }`, mirroring `{ tasks }` on
// GET /tasks/employee/:uid and `{ applications }` on
// GET /applications/employee/:uid, and both are failures-only counterparts of
// those endpoints. The success body is new, so it is defined here rather than
// inherited.

const employmentService = require('../services/employmentService');

/**
 * Maps a service failure onto the HTTP response.
 *
 * The same helper the other three controllers use. Validation failures are turned
 * into a 400 and skip the console.error; nothing else in this resource raises a
 * domain error today (both reads are a single query), so the 500 path exists for
 * an unexpected Firestore failure only.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof employmentService.EmploymentValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * GET /employments/employee/:uid
 *
 * The employee's own employments. Guarded by requireSelfParam('uid') in the
 * router, which compares the path parameter against the verified token and
 * answers 403 on a mismatch, so no second user can read this list -- the
 * authorization lives in the router, exactly as it does for the applications and
 * tasks reads, and this handler makes no request-scoped decision of its own.
 */
const listEmploymentsForEmployee = async (req, res) => {
    const { uid } = req.params;

    try {
        const employments = await employmentService.listEmploymentsForEmployee(uid);

        res.status(200).json({ employments });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employments:',
            message: 'Failed to fetch employments',
        });
    }
};

/**
 * GET /employments/employer/:uid
 *
 * The employer's own employments, guarded by requireSelfParam('uid') on the same
 * terms as the employee read: a 403 for any uid that is not the caller, with no
 * employment data in the body.
 *
 * Note that the guard is about identity, not role. A caller may read this path
 * for their own uid whether or not they have ever hired anyone, and gets an empty
 * list -- the same behaviour as GET /jobs/employer/:uid. Nothing checks
 * `users.role`, so no role assumption is introduced here.
 */
const listEmploymentsForEmployer = async (req, res) => {
    const { uid } = req.params;

    try {
        const employments = await employmentService.listEmploymentsForEmployer(uid);

        res.status(200).json({ employments });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employments for employer:',
            message: 'Failed to fetch employments',
        });
    }
};

module.exports = {
    listEmploymentsForEmployee,
    listEmploymentsForEmployer,
};