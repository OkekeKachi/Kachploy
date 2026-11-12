const { db } = require('../config/firebase');

const addEvidence = async (data) => {
    const ref = await db.collection('disputeEvidence').add(data);
    return ref.id;
};

const listEvidenceByDispute = (disputeId) =>
    db.collection('disputeEvidence').where('disputeId', '==', disputeId).get();

module.exports = {
    addEvidence,
    listEvidenceByDispute,
};
