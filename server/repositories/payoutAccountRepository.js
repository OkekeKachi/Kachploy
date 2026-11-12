'use strict';

const { db } = require('../config/firebase');

const getPayoutAccount = (uid) => db.collection('payoutAccounts').doc(uid).get();

const savePayoutAccount = (uid, data) =>
    db.collection('payoutAccounts').doc(uid).set(data, { merge: true });

module.exports = {
    getPayoutAccount,
    savePayoutAccount,
};
