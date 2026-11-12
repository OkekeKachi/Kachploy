import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROPOSAL_ACCEPTED,
    PROPOSAL_CHANGES_REQUESTED,
    PROPOSAL_PENDING,
    PROPOSAL_STATUSES,
    buildProposalPayload,
    canCreateProposal,
    canFinalizeHire,
    employmentWorkspacePath,
    findHireEmployment,
    formatProposalAmount,
    proposalEditorMode,
    proposalFormValues,
    proposalStatusBadgeVariant,
    proposalStatusLabel,
    selectActiveProposal,
} from '../src/components/proposalPresentation.js';

// ---------------------------------------------------------------------------
// Status handling
// ---------------------------------------------------------------------------

test('the three proposal statuses are exactly the ones the backend writes', () => {
    assert.deepEqual(PROPOSAL_STATUSES, [
        'pending_acceptance',
        'changes_requested',
        'accepted',
    ]);
});

test('a recognised status renders its label and badge variant', () => {
    assert.equal(proposalStatusLabel(PROPOSAL_PENDING), 'Awaiting employee response');
    assert.equal(proposalStatusLabel(PROPOSAL_CHANGES_REQUESTED), 'Changes requested');
    assert.equal(proposalStatusLabel(PROPOSAL_ACCEPTED), 'Terms accepted');

    assert.equal(proposalStatusBadgeVariant(PROPOSAL_PENDING), 'warning');
    assert.equal(proposalStatusBadgeVariant(PROPOSAL_CHANGES_REQUESTED), 'info');
    assert.equal(proposalStatusBadgeVariant(PROPOSAL_ACCEPTED), 'success');
});

test('a missing or unrecognised status is not guessed', () => {
    assert.equal(proposalStatusLabel(null), 'Status unavailable');
    assert.equal(proposalStatusLabel('cancelled'), 'Status unavailable');
    assert.equal(proposalStatusBadgeVariant(null), 'neutral');
    assert.equal(proposalStatusBadgeVariant('cancelled'), 'neutral');

    // No accidental success.
    assert.notEqual(proposalStatusBadgeVariant('cancelled'), 'success');
});

// ---------------------------------------------------------------------------
// Active proposal selection
// ---------------------------------------------------------------------------

test('an accepted proposal outranks changes_requested and pending proposals', () => {
    const pending = { id: 'p', status: PROPOSAL_PENDING };
    const changes = { id: 'c', status: PROPOSAL_CHANGES_REQUESTED };
    const accepted = { id: 'a', status: PROPOSAL_ACCEPTED };

    assert.equal(selectActiveProposal([pending, changes, accepted]), accepted);
    assert.equal(selectActiveProposal([accepted, changes, pending]), accepted);
});

test('changes_requested outranks a pending proposal', () => {
    const pending = { id: 'p', status: PROPOSAL_PENDING };
    const changes = { id: 'c', status: PROPOSAL_CHANGES_REQUESTED };

    assert.equal(selectActiveProposal([pending, changes]), changes);
    assert.equal(selectActiveProposal([changes, pending]), changes);
});

test('unknown or malformed proposals are ignored rather than chosen', () => {
    const pending = { id: 'p', status: PROPOSAL_PENDING };

    assert.equal(selectActiveProposal([null, {}, { id: 'x', status: 'draft' }, pending]), pending);
    assert.equal(selectActiveProposal([null, { id: 'x', status: 'draft' }]), null);
});

test('no proposal list has no active proposal', () => {
    assert.equal(selectActiveProposal([]), null);
    assert.equal(selectActiveProposal(null), null);
    assert.equal(selectActiveProposal(undefined), null);
});

// ---------------------------------------------------------------------------
// Hiring gate: the whole point of the proposal workflow
// ---------------------------------------------------------------------------

test('hiring may be finalized only for an interviewed applicant with an accepted proposal', () => {
    const accepted = [{ id: 'a', status: PROPOSAL_ACCEPTED }];

    assert.equal(canFinalizeHire('interviewed', accepted), true);
    assert.equal(canFinalizeHire('pending', accepted), false);
    assert.equal(canFinalizeHire('rejected', accepted), false);
    assert.equal(canFinalizeHire('accepted', accepted), false);
});

test('an accepted proposal alone is not enough when the applicant is not cleared for hiring', () => {
    const accepted = [{ id: 'a', status: PROPOSAL_ACCEPTED }];

    assert.equal(canFinalizeHire('pending', accepted), false);
    assert.equal(canFinalizeHire('rejected', accepted), false);
});

test('being interviewed is not enough without an accepted proposal', () => {
    assert.equal(canFinalizeHire('interviewed', []), false);
    assert.equal(canFinalizeHire('interviewed', null), false);
    assert.equal(canFinalizeHire('interviewed', [{ id: 'p', status: PROPOSAL_PENDING }]), false);
    assert.equal(canFinalizeHire('interviewed', [{ id: 'c', status: PROPOSAL_CHANGES_REQUESTED }]), false);
});

// ---------------------------------------------------------------------------
// Employer editor mode
// ---------------------------------------------------------------------------

test('the proposal editor offers create only when no proposal exists', () => {
    assert.equal(proposalEditorMode([]), 'create');
    assert.equal(proposalEditorMode(null), 'create');
    assert.equal(proposalEditorMode([{ id: 'p', status: PROPOSAL_PENDING }]), 'pending');
    assert.equal(proposalEditorMode([{ id: 'c', status: PROPOSAL_CHANGES_REQUESTED }]), 'revise');
    assert.equal(proposalEditorMode([{ id: 'a', status: PROPOSAL_ACCEPTED }]), 'accepted');
});

test('the most final proposal determines the editor mode', () => {
    const pending = { id: 'p', status: PROPOSAL_PENDING };
    const changes = { id: 'c', status: PROPOSAL_CHANGES_REQUESTED };
    const accepted = { id: 'a', status: PROPOSAL_ACCEPTED };

    assert.equal(proposalEditorMode([pending, changes]), 'revise');
    assert.equal(proposalEditorMode([pending, changes, accepted]), 'accepted');
});

test('creating a second proposal is refused while any proposal exists', () => {
    assert.equal(canCreateProposal('interviewed', []), true);
    assert.equal(canCreateProposal('interviewed', null), true);
    assert.equal(canCreateProposal('interviewed', [{ id: 'p', status: PROPOSAL_PENDING }]), false);
    assert.equal(canCreateProposal('interviewed', [{ id: 'c', status: PROPOSAL_CHANGES_REQUESTED }]), false);
    assert.equal(canCreateProposal('interviewed', [{ id: 'a', status: PROPOSAL_ACCEPTED }]), false);
});

test('creating a proposal is unavailable before the applicant is cleared for hiring', () => {
    assert.equal(canCreateProposal('pending', []), false);
    assert.equal(canCreateProposal('rejected', []), false);
    assert.equal(canCreateProposal('accepted', []), false);
});

// ---------------------------------------------------------------------------
// Form values and payloads
// ---------------------------------------------------------------------------

test('a create form starts empty with one milestone row', () => {
    const values = proposalFormValues(null);

    assert.deepEqual(values, {
        paymentMode: 'full',
        totalAmount: '',
        milestones: [{ label: '', amountMinor: '', description: '' }],
    });
});

test('a full-payment proposal prefills stored kobo as naira and keeps milestone defaults', () => {
    const values = proposalFormValues({
        paymentMode: 'full',
        totalAmountMinor: 50000000,
        milestones: [],
    });

    assert.equal(values.paymentMode, 'full');
    assert.equal(values.totalAmount, '500000');
    assert.deepEqual(values.milestones, [{ label: '', amountMinor: '', description: '' }]);

    const result = buildProposalPayload('app-1', values);

    assert.equal(result.ok, true);
    assert.equal(result.payload.totalAmountMinor, 50000000);
});

test('a milestone proposal prefills every row as naira, including stored zero', () => {
    const values = proposalFormValues({
        paymentMode: 'milestones',
        totalAmountMinor: 30000000,
        milestones: [
            { label: 'Design', amountMinor: 10000000, description: 'Wireframes' },
            { label: 'Build', amountMinor: 0, description: '' },
            { label: 'Ship', amountMinor: null },
        ],
    });

    assert.equal(values.paymentMode, 'milestones');
    assert.equal(values.totalAmount, '300000');
    assert.deepEqual(values.milestones, [
        { label: 'Design', amountMinor: '100000', description: 'Wireframes' },
        { label: 'Build', amountMinor: '0', description: '' },
        { label: 'Ship', amountMinor: '', description: '' },
    ]);
});

test('a revision resubmits stored kobo unchanged after the naira round trip', () => {
    const values = proposalFormValues({
        paymentMode: 'milestones',
        totalAmountMinor: 50000000,
        milestones: [
            { label: 'Design', amountMinor: 20000000, description: '' },
            { label: 'Build', amountMinor: 30000000, description: '' },
        ],
    });

    assert.deepEqual(values.milestones.map((milestone) => milestone.amountMinor), ['200000', '300000']);

    const result = buildProposalPayload('app-1', values);

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload.milestones, [
        { label: 'Design', amountMinor: 20000000, description: '' },
        { label: 'Build', amountMinor: 30000000, description: '' },
    ]);
});

test('a full-payment form converts naira to kobo and sends no milestones', () => {
    const result = buildProposalPayload('app-1', {
        paymentMode: 'full',
        totalAmount: '500000',
        milestones: [{ label: 'ignored', amountMinor: '1', description: '' }],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
        applicationId: 'app-1',
        paymentMode: 'full',
        totalAmountMinor: 50000000,
    });
});

test('a milestone form filters blank rows and converts naira amounts to kobo', () => {
    const result = buildProposalPayload('app-1', {
        paymentMode: 'milestones',
        totalAmount: '300000',
        milestones: [
            { label: 'Design', amountMinor: '100000', description: 'Wireframes' },
            { label: '', amountMinor: '200000', description: 'no label' },
            { label: 'Build', amountMinor: '', description: 'no amount' },
            { label: 'Ship', amountMinor: '500000', description: '' },
        ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
        applicationId: 'app-1',
        paymentMode: 'milestones',
        milestones: [
            { label: 'Design', amountMinor: 10000000, description: 'Wireframes' },
            { label: 'Ship', amountMinor: 50000000, description: '' },
        ],
    });
});

test('decimal naira amounts convert without floating-point drift', () => {
    const result = buildProposalPayload('app-1', {
        paymentMode: 'full',
        totalAmount: '500000.50',
    });

    assert.equal(result.ok, true);
    assert.equal(result.payload.totalAmountMinor, 50000050);
});

test('invalid, zero, negative and over-precision amounts are rejected visibly', () => {
    for (const totalAmount of ['', 'abc', '0', '-5', '5.555', '1,000', '5e3', 'Infinity', '10000000001']) {
        const result = buildProposalPayload('app-1', { paymentMode: 'full', totalAmount });

        assert.equal(result.ok, false, `expected ${totalAmount} to be rejected`);
        assert.match(result.error, /positive total amount in naira/i);
    }

    const zeroMilestone = buildProposalPayload('app-1', {
        paymentMode: 'milestones',
        milestones: [{ label: 'Design', amountMinor: '0', description: '' }],
    });

    assert.equal(zeroMilestone.ok, false);
    assert.match(zeroMilestone.error, /positive amount in naira/i);
});

test('proposal summaries render stored kobo as naira', () => {
    assert.equal(formatProposalAmount(50000000), '₦500,000.00');
    assert.equal(formatProposalAmount(50000050), '₦500,000.50');
    assert.equal(formatProposalAmount(null), '—');
});

// ---------------------------------------------------------------------------
// Post-hire employment lookup and destination
// ---------------------------------------------------------------------------

test('the hire is found by applicationId, whether the id is deterministic or auto-generated', () => {
    const employments = [
        { id: 'emp-other', applicationId: 'app-other' },
        { id: 'auto-id', applicationId: 'app-1' },
    ];

    assert.equal(findHireEmployment(employments, 'app-1').id, 'auto-id');
});

test('a deterministic employment id equal to the application id is also matched', () => {
    const employments = [{ id: 'app-1', applicationId: 'app-1' }];

    assert.equal(findHireEmployment(employments, 'app-1').id, 'app-1');
});

test('the lookup refuses to guess when the hire is absent or the input is malformed', () => {
    assert.equal(findHireEmployment([], 'app-1'), null);
    assert.equal(findHireEmployment([{ id: 'emp-other', applicationId: 'app-other' }], 'app-1'), null);
    assert.equal(findHireEmployment(null, 'app-1'), null);
    assert.equal(findHireEmployment([{ id: 'app-1' }], ''), null);
});

test('the workspace path names the job and the employment', () => {
    assert.equal(
        employmentWorkspacePath('job-9', 'emp-3'),
        '/employer/jobs/job-9/employments/emp-3'
    );
});
