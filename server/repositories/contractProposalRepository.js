'use strict';

const { db } = require('../config/firebase');

const addProposal = async (data) => {
    const ref = await db.collection('contractProposals').add(data);
    return ref.id;
};

const setProposal = async (proposalId, data) => {
    await db.collection('contractProposals').doc(proposalId).set(data);
};

const updateProposalFields = async (proposalId, partial) => {
    await db.collection('contractProposals').doc(proposalId).update(partial);
};

const getProposalById = (proposalId) =>
    db.collection('contractProposals').doc(proposalId).get();

const listProposalsByApplication = async (applicationId) => {
    return db.collection('contractProposals').where('applicationId', '==', applicationId).get();
};

const listProposalsByJob = async (jobId) => {
    return db.collection('contractProposals').where('jobId', '==', jobId).get();
};

module.exports = {
    addProposal,
    setProposal,
    updateProposalFields,
    getProposalById,
    listProposalsByApplication,
    listProposalsByJob,
};
