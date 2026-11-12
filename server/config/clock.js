// clock.js
//
// The process clock, behind one function. Every Stage 1 decision that depends on
// "now" -- the review deadline, whether that deadline has passed, and the
// timestamps written to the review-event and admin-decision histories -- reads it
// from here rather than calling `new Date()` at the call site.
//
// Production behaviour is unchanged: with no override installed, `now()` returns
// the current time. The override exists for tests, which need to place a task on
// either side of its seven-day window without waiting seven days; the harness
// installs the same clock it gives the fake Firestore, so the wall clock and the
// stored `submittedAt` cannot disagree inside one test.

let override = null;

const now = () => (override ? new Date(override()) : new Date());

const nowMs = () => now().getTime();

const setClock = (fn) => {
    override = typeof fn === 'function' ? fn : null;
};

const resetClock = () => {
    override = null;
};

module.exports = {
    now,
    nowMs,
    setClock,
    resetClock,
};
