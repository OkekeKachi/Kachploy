// releaseEligibilityService.js
//
// STAGE 1. Whether an employment's work MAY be released. This is a READ-ONLY
// projection: it never writes a payment, never calls a provider, and never claims
// money moved. Those are deliberately out of scope for this stage.
//
// The eligibility of one task is derived from four facts:
//
//   1. the work is settled -- `approved`, or `resolved` in the employee's favour;
//   2. the milestone's payment record is `paid` (funding confirmed);
//   3. no open dispute names the task or the employment;
//   4. no release marker exists on the payment.
//
// `paid` is funding, NOT release. A milestone-linked task cannot even be created
// until its payment is `paid`, so reading `paid` as "already released" would make
// every milestone task permanently ineligible. Release is recorded by a marker
// this stage never writes; until a later stage adds one, fact 4 is always true.
//
// The response carries no `released` value. "Eligible" means the conditions a
// future release action would have to re-check are satisfied now; it is not a
// promise, and it does not reserve funds.

const taskRepository = require('../repositories/taskRepository');
const contractRepository = require('../repositories/contractRepository');
const paymentRepository = require('../repositories/paymentRepository');
const disputeRepository = require('../repositories/disputeRepository');
const clock = require('../config/clock');

const OPEN_DISPUTE_STATUSES = ['open', 'under_review'];

const toPlain = (snapshot) => {
    const rows = [];
    if (!snapshot) return rows;
    if (Array.isArray(snapshot)) {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
        return rows;
    }
    if (Array.isArray(snapshot.docs)) return toPlain(snapshot.docs);
    if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
    }
    return rows;
};

const releasedPayment = (payment) =>
    Boolean(payment) && (payment.releasedAt != null || payment.releaseStatus === 'released');

const workSettled = (task) =>
    task.status === 'approved'
    || (task.status === 'resolved' && task.resolution && task.resolution.outcome === 'employee_favoured');

const getReleaseEligibility = async (employmentId) => {
    const [tasksSnap, milestonesSnap, disputesSnap] = await Promise.all([
        taskRepository.listTasksByEmployment(employmentId),
        contractRepository.listMilestonesByContract(employmentId),
        disputeRepository.listDisputesByEmployment(employmentId),
    ]);

    const tasks = toPlain(tasksSnap);
    const milestones = toPlain(milestonesSnap);
    const openDisputes = toPlain(disputesSnap).filter((d) =>
        OPEN_DISPUTE_STATUSES.includes(d.status)
    );

    const payments = new Map();
    for (const task of tasks) {
        if (task.milestoneId && !payments.has(task.milestoneId)) {
            const snapshot = await paymentRepository.getPaymentByMilestoneId(task.milestoneId);
            payments.set(task.milestoneId, snapshot.exists ? snapshot.data() : null);
        }
    }

    const items = tasks.map((task) => {
        const payment = task.milestoneId ? payments.get(task.milestoneId) : null;
        const fundingConfirmed = task.milestoneId ? Boolean(payment) && payment.status === 'paid' : true;
        const openDispute = openDisputes.find(
            (d) => d.taskId === task.id || (!d.taskId && d.employmentId === employmentId)
        );
        const alreadyReleased = task.milestoneId ? releasedPayment(payment) : false;
        const settled = workSettled(task);

        let status = 'eligible';
        let reason = 'work_settled_and_funding_confirmed';

        if (alreadyReleased) {
            status = 'ineligible';
            reason = 'already_released';
        } else if (openDispute) {
            status = 'blocked';
            reason = 'open_dispute';
        } else if (!fundingConfirmed) {
            status = 'ineligible';
            reason = 'funding_not_confirmed';
        } else if (!settled) {
            status = 'blocked';
            reason = 'work_not_approved';
        }

        return {
            taskId: task.id,
            milestoneId: task.milestoneId || null,
            workStatus: task.status || 'assigned',
            fundingConfirmed,
            alreadyReleased,
            status,
            reason,
            blockedByDisputeId: openDispute ? openDispute.id : null,
        };
    });

    const blocking = items.find((item) => item.status === 'blocked');
    const ineligible = items.find((item) => item.status === 'ineligible');

    let status;
    let reason;

    if (items.length === 0) {
        status = 'ineligible';
        reason = 'no_tasks';
    } else if (ineligible) {
        status = 'ineligible';
        reason = ineligible.reason;
    } else if (blocking) {
        status = 'blocked';
        reason = blocking.reason;
    } else {
        status = 'eligible';
        reason = 'all_tasks_settled';
    }

    return {
        employmentId,
        status,
        reason,
        fundingConfirmed: items.every((item) => item.fundingConfirmed),
        blockedByDisputeId: blocking ? blocking.blockedByDisputeId : null,
        milestones: milestones.map((m) => m.id),
        tasks: items,
        computedAt: clock.now(),
        releaseRecorded: false,
    };
};

module.exports = {
    OPEN_DISPUTE_STATUSES,
    getReleaseEligibility,
};
