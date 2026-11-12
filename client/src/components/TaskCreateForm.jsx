import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import api, { fetchContractForEmployment, fetchPaymentForMilestone } from '../api';
import Button from './ui/Button';
import { Field, Input, Textarea, Select } from './ui/Field';
import {
    SUBMISSION_TYPE_LABELS,
    SUBMISSION_TYPES,
} from './taskPresentation';
import { milestonePaymentIsConfirmed, paymentStatusLabel } from './paymentPresentation';

const TaskCreateForm = ({
    jobId,
    employeeId,
    employmentId,
    applicantName,
    onCreated,
    paymentsKey = 0,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [taskName, setTaskName] = useState('');
    const [taskDescription, setTaskDescription] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [submissionType, setSubmissionType] = useState('');
    const [milestones, setMilestones] = useState([]);
    const [milestoneId, setMilestoneId] = useState('');
    const [loadingMilestones, setLoadingMilestones] = useState(false);
    // milestoneId -> payment record. Loaded alongside the milestones so the form
    // can mark each option as funded or not. Unavailable data is treated as not
    // paid (fail closed).
    const [milestonePayments, setMilestonePayments] = useState({});
    const [paymentsLoading, setPaymentsLoading] = useState(false);
    const [milestoneError, setMilestoneError] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const [createNotice, setCreateNotice] = useState('');

    const createInFlightRef = useRef(false);
    // Mirrors the milestones currently loaded into the form so the payments
    // refresh effect can re-fetch exactly those milestones without depending on
    // the (re-created) milestones state array.
    const milestonesRef = useRef([]);

    const canCreate =
        taskName.trim().length > 0 &&
        taskDescription.trim().length > 0 &&
        dueDate.length > 0 &&
        SUBMISSION_TYPES.includes(submissionType);

    const openForm = async () => {
        setIsOpen(true);
        setCreateError('');
        setCreateNotice('');

        if (!employmentId) return;

        setLoadingMilestones(true);
        setMilestoneError('');
        setMilestonePayments({});
        setPaymentsLoading(false);

        try {
            const { milestones: loaded } = await fetchContractForEmployment(employmentId);
            const milestoneList = Array.isArray(loaded) ? loaded : [];
            setMilestones(milestoneList);
            milestonesRef.current = milestoneList;

            const milestoneIds = milestoneList
                .filter((m) => m && m.id)
                .map((m) => m.id);

            if (milestoneIds.length) {
                setPaymentsLoading(true);
                try {
                    const results = await Promise.all(
                        milestoneIds.map(async (id) => {
                            try {
                                const { payment } = await fetchPaymentForMilestone(id);
                                return [id, payment || null];
                            } catch {
                                // Fail closed: unavailable payment data is not funded.
                                return [id, null];
                            }
                        })
                    );
                    setMilestonePayments(Object.fromEntries(results));
                } finally {
                    setPaymentsLoading(false);
                }
            }
        } catch {
            setMilestones([]);
            setMilestoneError('Milestones could not be loaded. You can still create the task without one.');
        } finally {
            setLoadingMilestones(false);
        }
    };

    // When the payment status is refreshed or verified elsewhere in the
    // workspace (MilestonePaymentPanel bumps paymentsKey), re-fetch the
    // payments for the milestones this form is showing so an already-open form
    // stays in sync without the employer having to close and reopen it. Only
    // fires on an explicit refresh signal -- no polling, no verification loop.
    useEffect(() => {
        if (!employmentId) return;
        const ids = milestonesRef.current
            .filter((m) => m && m.id)
            .map((m) => m.id);
        if (!ids.length) return;

        let active = true;
        (async () => {
            const results = await Promise.all(
                ids.map(async (id) => {
                    try {
                        const { payment } = await fetchPaymentForMilestone(id);
                        return [id, payment || null];
                    } catch {
                        // Fail closed: unavailable payment data is not funded.
                        return [id, null];
                    }
                })
            );
            if (!active) return;
            setMilestonePayments((prev) => ({ ...prev, ...Object.fromEntries(results) }));
        })();

        return () => {
            active = false;
        };
    }, [paymentsKey, employmentId]);

    const createTask = async () => {
        if (createInFlightRef.current || !canCreate) return;

        // Fail closed: a milestone-linked task may only be created once that
        // milestone's payment is confirmed paid. The server enforces this too,
        // but refusing here avoids a confusing round trip.
        if (milestoneId && !milestonePaymentIsConfirmed(milestonePayments[milestoneId])) {
            setCreateError(
                'This milestone must be paid before a task can be created for it. Confirm the payment first, or leave the milestone unlinked.'
            );
            return;
        }

        createInFlightRef.current = true;
        setIsCreating(true);
        setCreateError('');
        setCreateNotice('');

        try {
            await api.post('/tasks', {
                jobId,
                employeeId,
                taskName: taskName.trim(),
                taskDescription: taskDescription.trim(),
                dueDate: new Date(dueDate).toISOString(),
                submissionType,
                ...(milestoneId ? { milestoneId } : {}),
            });

            setTaskName('');
            setTaskDescription('');
            setDueDate('');
            setSubmissionType('');
            setMilestoneId('');

            const refreshed = await onCreated();
            setCreateNotice(
                refreshed
                    ? `A task was created for ${applicantName || 'this employee'}.`
                    : 'The task was created, but the task list could not be refreshed -- reload the page to see it.'
            );
        } catch (err) {
            console.error('Error creating task:', err);
            setCreateError(`This task was not created: ${err.message || 'the request failed'}.`);
        } finally {
            createInFlightRef.current = false;
            setIsCreating(false);
        }
    };

    return (
        <div className="mt-4 border-t border-border pt-4">
            {!isOpen ? (
                <Button type="button" variant="secondary" size="sm" onClick={openForm}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add a task
                </Button>
            ) : (
                <div className="space-y-3">
                    <h5 className="text-sm font-semibold text-foreground">New task</h5>

                    <Field id={`task-name-${employeeId}`} label="Task name">
                        <Input
                            id={`task-name-${employeeId}`}
                            type="text"
                            value={taskName}
                            onChange={(event) => setTaskName(event.target.value)}
                            disabled={isCreating}
                            placeholder="What needs to be delivered"
                        />
                    </Field>

                    <Field id={`task-description-${employeeId}`} label="Description">
                        <Textarea
                            id={`task-description-${employeeId}`}
                            value={taskDescription}
                            onChange={(event) => setTaskDescription(event.target.value)}
                            disabled={isCreating}
                            rows={4}
                            placeholder="Describe the work and what a finished submission looks like"
                        />
                    </Field>

                    <Field id={`task-submission-type-${employeeId}`} label="Deliver by">
                        <Select
                            id={`task-submission-type-${employeeId}`}
                            value={submissionType}
                            onChange={(event) => setSubmissionType(event.target.value)}
                            disabled={isCreating}
                            required
                        >
                            <option value="">Choose how this task is delivered</option>
                            {SUBMISSION_TYPES.map((type) => (
                                <option key={type} value={type}>
                                    {SUBMISSION_TYPE_LABELS[type]}
                                </option>
                            ))}
                        </Select>
                    </Field>

                    {employmentId && (
                        <Field
                            id={`task-milestone-${employeeId}`}
                            label="Milestone (optional)"
                            hint="Link this task to the payment stage it delivers. Work can only begin on a milestone once its payment is confirmed as Paid."
                        >
                            <Select
                                id={`task-milestone-${employeeId}`}
                                value={milestoneId}
                                onChange={(event) => setMilestoneId(event.target.value)}
                                disabled={isCreating || loadingMilestones || paymentsLoading}
                            >
                                <option value="">
                                    {loadingMilestones || paymentsLoading
                                        ? 'Loading milestones...'
                                        : 'No milestone'}
                                </option>
                                {milestones.map((milestone) => {
                                    const payment = milestonePayments[milestone.id];
                                    const paid = milestonePaymentIsConfirmed(payment);
                                    return (
                                        <option
                                            key={milestone.id}
                                            value={milestone.id}
                                            disabled={!paid}
                                        >
                                            {milestone.label || milestone.id}
                                            {!paid ? ` — ${paymentStatusLabel(payment)}` : ''}
                                        </option>
                                    );
                                })}
                            </Select>
                            {milestoneError && (
                                <p className="mt-1 text-xs text-warning">{milestoneError}</p>
                            )}
                        </Field>
                    )}

                    <Field id={`task-due-date-${employeeId}`} label="Due date">
                        <Input
                            id={`task-due-date-${employeeId}`}
                            type="date"
                            value={dueDate}
                            onChange={(event) => setDueDate(event.target.value)}
                            disabled={isCreating}
                        />
                    </Field>

                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                            type="button"
                            size="sm"
                            onClick={createTask}
                            disabled={isCreating || !canCreate}
                        >
                            {isCreating ? 'Creating...' : 'Create task'}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setIsOpen(false)}
                            disabled={isCreating}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {createError && (
                <p role="alert" className="mt-3 text-sm font-medium text-danger">
                    {createError}
                </p>
            )}
            {createNotice && !createError && (
                <p role="status" className="mt-3 text-sm font-medium text-success">
                    {createNotice}
                </p>
            )}
        </div>
    );
};

export default TaskCreateForm;
