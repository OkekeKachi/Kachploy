import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Badge from './ui/Badge';
import Button from './ui/Button';
import {
    SUBMITTABLE_STATUSES,
    TASK_STATUS_LABELS,
    TASK_STATUS_ORDER,
    dateLabel,
    isValidHttpUrl,
    milestoneLabelForTask,
    taskStatus,
    taskStatusBadgeLabel,
    taskStatusBadgeVariant,
    taskSubmissionType,
    taskSubmissionTypeLabel,
} from './taskPresentation';
import {
    formatKoboAsNaira,
    milestonePaymentIsConfirmed,
    paymentStatusBadgeVariant,
    paymentStatusLabel,
} from './paymentPresentation';

/**
 * The employee's task card, the per-job progress summary, and the one place a
 * submission is rendered.
 *
 * STAGE 10F: extracted out of HiredJobs.jsx so the My Jobs list and the new
 * per-job workspace share ONE definition of the Stage 9D submission workflow
 * instead of two. The alternative -- copying the card into the workspace page --
 * would have produced two places that own the draft state, the double-click guard
 * and the status rules, which is exactly the duplication Stage 9D removed when it
 * pulled the card out of the list's inline `tasks.map`, and which would drift the
 * moment either copy changed.
 *
 * STAGE 10G: the submit control is now chosen by the task's `submissionType` -- a
 * textarea, a url field or a file picker -- and SubmittedWork joins this module for
 * the same reason the card is here at all: the employee and the employer must see the
 * same delivery rendered the same way, and there are now three shapes of it.
 *
 * STAGE 10G.1: a file is uploaded with a signature minted by this app's own server
 * (POST /tasks/:id/upload-signature) and goes straight from the browser to
 * Cloudinary. The server never sees the bytes; what it does control is WHERE they
 * land, because the folder in the signature is derived from the task's id and the
 * signature cannot be rewritten without the api secret, which exists only in the
 * server's environment. This replaced the Stage 10G Firebase Storage upload: the
 * avatar uploads in Profile.jsx and completeProfile.jsx still use Firebase Storage
 * and are untouched by this change.
 *
 * This module holds components only. The pure helpers it and its callers need --
 * the date decoder, the status labels, the submission types, the employment label and
 * the task-to-hire grouping -- live in ./taskPresentation.js, so that exporting them
 * from here cannot cost this file its fast refresh.
 */

// Mirrors the local helper of the same name in ConversationThread.jsx and
// MyApplications.jsx. Those files each keep their own copy and both document that
// there is deliberately no shared module, so this is another local copy of the same
// three-property read rather than a refactor of the others, which would be out of
// scope here. It matters for this card because the three failures it now reports --
// an unsigned request, a refused upload and a refused submission -- all arrive from
// a server that puts the reason in `message`, and `err.message` on its own would
// report only axios's "Request failed with status code 400".
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

/**
 * STAGE 10G.1. Uploads one file to Cloudinary using a signature from this app's own
 * server, and returns the reference to submit.
 *
 * THE THREE STEPS, AND WHAT EACH ONE CAN TAKE WITH IT:
 *
 *   1. POST /tasks/:id/upload-signature -- authenticated, guarded by the same
 *      requireTaskParty as the submit it precedes, and answered with
 *      `{ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType }`.
 *      Nothing is uploaded yet, and a failure here leaves the task untouched.
 *
 *   2. The upload itself: a multipart POST to
 *      https://api.cloudinary.com/v1_1/{cloud}/{resourceType}/upload carrying the
 *      file, the api key, the timestamp, the signature and the two signed path
 *      values. This is the only network call in the flow that does not go to this
 *      app's API, and it is why the server's api secret must never reach the page:
 *      the signature is what grants this one upload, and it is useless for anything
 *      else. `resource_type` selects the endpoint rather than being sent as a form
 *      field, because the signed parameter set is exactly what the server signed --
 *      adding to it would change the string Cloudinary hashes and reject the request.
 *
 *   3. The response supplies `secure_url` and `public_id`, which the caller sends to
 *      POST /tasks/:id/submit as `submissionFile`.
 *
 * A failure at step 1 or 2 throws before step 3 exists, so the task stays in whatever
 * status it held. The thrown message is the one the employee reads: Cloudinary's own
 * `error.message` when it refused the upload, the server's message when it refused to
 * sign, or a fallback when the request never got a reply.
 *
 * NOT REACHED BY TEXT OR LINK SUBMISSIONS, which post straight to the API as before.
 */
const uploadToCloudinary = async (file, taskId) => {
    // Which of the two steps this call is in, so a failure anywhere below reaches the
    // submit handler already labelled. `step` starts at 'sign' and moves to 'upload'
    // the moment the signature is in hand, and the catch turns whatever went wrong
    // into one Error carrying both the readable reason and that label.
    let step = 'sign';

    try {
        const signed = await api.post(`/tasks/${taskId}/upload-signature`);
        const { cloudName, apiKey, timestamp, signature, folder, publicId, resourceType } = signed.data;

        step = 'upload';

        const form = new FormData();
        form.append('file', file);
        form.append('api_key', apiKey);
        form.append('timestamp', String(timestamp));
        form.append('signature', signature);
        form.append('folder', folder);
        form.append('public_id', publicId);

        const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;
        const response = await fetch(uploadUrl, { method: 'POST', body: form });

        const result = await response.json().catch(() => null);

        if (!response.ok || !result || result.error) {
            throw new Error((result && result.error && result.error.message) || `the upload failed (${response.status})`);
        }

        if (!result.secure_url || !result.public_id) {
            throw new Error('the upload response did not include a file reference');
        }

        return {
            url: result.secure_url,
            publicId: result.public_id,
            name: file.name,
            resourceType,
        };
    } catch (err) {
        const failure = new Error(readErrorMessage(err, (err && err.message) || 'the upload failed'));
        failure.step = step;
        throw failure;
    }
};

/**
 * STAGE 10G. One delivery, rendered.
 *
 * Used by the employee card above and by the employer's review panel on
 * ViewJobApplications.jsx, because both have to show the same thing and there are now
 * three shapes of it: prose, a link, or a file. Rendering that switch twice is how the
 * two views end up disagreeing about what was delivered -- and the employer is the one
 * who has to approve it.
 *
 * `fallback` is what to say when the task claims to be submitted but carries nothing.
 * The employer's panel passes the sentence it has always shown; the employee's card
 * passes none, because a task in `submitted` with no recorded work is a server-side
 * oddity rather than something the card needs to explain.
 *
 * Returns null when there is nothing to show AND no fallback, which is what lets the
 * revision panel keep its existing "only render this if there is something" behaviour.
 *
 * Text falls back to `submittedBody`, the field every submission before Stage 10G was
 * written to. That is the whole of the backward compatibility: legacy tasks keep
 * displaying exactly what they always displayed, and nothing new reads or writes that
 * field.
 */
export const SubmittedWork = ({ task, label = 'Your submitted work', fallback = '' }) => {
    const type = taskSubmissionType(task);

    if (type === 'link' && task.submissionUrl) {
        return (
            <p style={{ margin: '10px 0' }}>
                <strong>{label}:</strong>{' '}
                <a href={task.submissionUrl} target="_blank" rel="noopener noreferrer">
                    {task.submissionUrl}
                </a>
            </p>
        );
    }

    if (type === 'file' && task.submissionFile && task.submissionFile.url) {
        return (
            <p style={{ margin: '10px 0' }}>
                <strong>{label}:</strong>{' '}
                <a href={task.submissionFile.url} target="_blank" rel="noopener noreferrer">
                    {task.submissionFile.name || 'the uploaded file'}
                </a>
            </p>
        );
    }

    const text = type === 'text' ? task.submissionText || task.submittedBody : '';

    if (!text) return fallback ? <p style={{ margin: '10px 0' }}>{fallback}</p> : null;

    return (
        <p style={{ margin: '10px 0' }}>
            <strong>{label}:</strong>{' '}
            <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
        </p>
    );
};

/**
 * STAGE 9D. The employee-side delivery workflow.
 *
 * Extracted from the list's inline `tasks.map` body so each card owns its own draft
 * and in-flight state. Holding that state in the page would mean one submission-error
 * string and one isSubmitting flag for the whole list, so failing one task would
 * disable and mislabel every other card.
 *
 * `refreshTask` re-reads this one task from the server after a successful submission
 * rather than patching the card optimistically. The submit response carries the new
 * status but not the rest of the record, and the server -- not this page -- is the
 * authority on it; re-reading also promotes a legacy task, whose stored document has
 * no status, to a card that shows its new state correctly.
 *
 * STAGE 10E-1: `readOnly` defaults to false, so every card inside a hired-job card
 * renders exactly the Stage 9D workflow -- the prop is additive and off by default.
 * It is passed only by the "work not linked to a hire" section, where the submit
 * control is withheld and replaced by an explanation. The read-only fields and the
 * job link are the same either way; nothing about the workflow above is altered for
 * a task that does have an employment.
 *
 * STAGE 10F: `refreshTask` is required whenever `readOnly` is false, because only a
 * submittable card can reach the submit handler that calls it. A read-only card never
 * renders that handler, so a view that only shows read-only cards passes nothing.
 *
 * STAGE 10G: the card holds one draft per submission type, because a task's type is
 * fixed at creation and there is no endpoint that changes it -- so exactly one of the
 * three is ever reachable, and keeping all three costs three small pieces of state
 * rather than a branch that has to reset the others.
 */
const TaskCard = ({ task, job, refreshTask, readOnly = false, milestones = [], milestonePayments = {} }) => {
    const [draft, setDraft] = useState('');
    const [linkDraft, setLinkDraft] = useState('');
    const [fileDraft, setFileDraft] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [workflowError, setWorkflowError] = useState('');
    const [notice, setNotice] = useState('');

    // STAGE 5I-1 convention, same reason as `hiringInFlightRef` in
    // ViewJobApplications.jsx: `isSubmitting` alone cannot stop a double click,
    // because two clicks in the same tick both read the pre-update render and both
    // would reach POST /tasks/:id/submit. The ref is checked and set synchronously,
    // before the first await, and released in `finally` so neither a failed
    // submission nor a failed refresh leaves the card stuck.
    //
    // STAGE 10G: the await this guard now covers can be an upload, which is slower than
    // a JSON POST and makes the race more likely rather than less. STAGE 10G.1 keeps
    // that true: the guard is taken BEFORE the signing request, so two clicks cannot
    // each ask for a signature and each upload the same file.
    const submittingInFlightRef = useRef(false);

    const status = taskStatus(task);
    const canSubmit = SUBMITTABLE_STATUSES.indexOf(status) !== -1;
    const submissionType = taskSubmissionType(task);
    const milestoneLabel = milestoneLabelForTask(task, milestones);
    const milestonePayment = task.milestoneId ? milestonePayments[task.milestoneId] : undefined;
    // Distinguishes "payment data was not loaded for this surface" (key absent:
    // render no status row) from "loaded, but no record exists" (key present but
    // null/undefined: fail closed and say the status is unavailable).
    const hasMilestonePaymentData = task.milestoneId
        ? Object.prototype.hasOwnProperty.call(milestonePayments, task.milestoneId)
        : false;

    // STAGE 10G. hasDraft is each type's own version of the rule the server enforces:
    // a non-empty submissionText, an http or https submissionUrl, or a chosen file.
    // The button is disabled until one of those holds rather than letting the request
    // fail with 400, so `disabled` is the honest signal; the browser does not fire the
    // click for it, which makes the guard inside `submit` the belt to that braces.
    // The link branch applies the server's own rule -- http or https, parsed -- rather
    // than only checking for characters, so the button is disabled on input the API
    // would refuse anyway.
    const hasDraft =
        submissionType === 'text'
            ? draft.trim().length > 0
            : submissionType === 'link'
              ? isValidHttpUrl(linkDraft)
              : fileDraft !== null;

    // STAGE 10G. Only meaningful for the file type: an input the employee has touched
    // but not finished. The submit button stays enabled on it, because "this is not a
    // valid link" is only useful next to a button they can press to be told so.
    const linkLooksWrong = submissionType === 'link' && linkDraft.trim().length > 0 && !isValidHttpUrl(linkDraft);

    const submit = async () => {
        if (submittingInFlightRef.current || !hasDraft) return;
        submittingInFlightRef.current = true;
        setIsSubmitting(true);
        setWorkflowError('');
        setNotice('');

        // STAGE 10G.1. Which of the three steps is in flight, so a failure can be
        // described as the step that failed rather than as "the submission". Text and
        // link never leave step 'submit'; a file walks sign -> upload -> submit, and
        // the first two both mean "nothing was submitted" while the task is left
        // exactly where it was.
        let step = 'submit';

        try {
            let payload;

            if (submissionType === 'link') {
                payload = { submissionUrl: linkDraft.trim() };
            } else if (submissionType === 'file') {
                step = 'sign';
                const submissionFile = await uploadToCloudinary(fileDraft, task.id);
                step = 'submit';
                payload = { submissionFile };
            } else {
                payload = { submissionText: draft };
            }

            await api.post(`/tasks/${task.id}/submit`, payload);

            // The draft is cleared only after the server accepted it, so a failed
            // submission never destroys work the employee typed. For a file that means
            // the picker is only reset once the task actually holds it.
            setDraft('');
            setLinkDraft('');
            setFileDraft(null);

            // STAGE 10G.1: the refresh is a read that can only fail on its own. It runs
            // after a submission the server has already accepted, so it must never fall
            // through to the catch below -- that would report "your work was not
            // submitted" for work that was. A thrown refresh is read the same as a
            // `false` return, which is the branch the message below was written for.
            const refreshed = await refreshTask(task.id).catch(() => false);
            setNotice(
                refreshed
                    ? 'Your work was submitted.'
                    : 'Your work was submitted, but this task could not be refreshed -- reload the page to see its current status.'
            );
        } catch (err) {
            console.error('Error submitting task:', err);

            // STAGE 9D: a transition refused as illegal, as unauthorized, or because
            // the employment has ended arrives as the server's message, which says
            // why. It is surfaced rather than replaced with a generic failure, because
            // the three cases need three different things from the employee: wait,
            // stop, or contact the employer. Stage 10G.1 adds the two upload steps in
            // front of it, each of which states plainly that nothing was submitted --
            // and neither of them has touched the task, so there is nothing to undo
            // and, unlike the Firebase version of this stage, no orphan to clean up:
            // the upload either landed in the signed folder or never happened.
            const reason = readErrorMessage(err, (err && err.message) || 'the request failed');
            const failedStep = (err && err.step) || step;

            if (failedStep === 'sign') {
                setWorkflowError(`Your file was not signed for upload, so nothing was submitted: ${reason}.`);
            } else if (failedStep === 'upload') {
                setWorkflowError(`Your file was not uploaded, so nothing was submitted: ${reason}.`);
            } else {
                setWorkflowError(`Your work was not submitted: ${reason}.`);
            }
        } finally {
            submittingInFlightRef.current = false;
            setIsSubmitting(false);
        }
    };

    return (
        <li
            style={{
                border: '1px solid #ccc',
                borderRadius: '10px',
                marginBottom: '10px',
                padding: '15px',
            }}
        >
            <h4>{task.taskName}</h4>
            <p>
                <strong>Job:</strong>{' '}
                {job ? (
                    <Link to={`/jobs/${task.jobId}`}>{job.title}</Link>
                ) : (
                    'Job details unavailable'
                )}
            </p>
            {job && job.location && (
                <p>
                    <strong>Location:</strong> {job.location}
                </p>
            )}
            {job && job.jobType && (
                <p>
                    <strong>Type:</strong> {job.jobType}
                </p>
            )}
            <p>
                <strong>Description:</strong> {task.taskDescription || 'No description'}
            </p>
            {task.milestoneId && (
                <>
                    <p>
                        <strong>Milestone:</strong> {milestoneLabel || 'Linked milestone'}
                    </p>
                    {milestonePayment ? (
                        <p>
                            <strong>Amount:</strong> {formatKoboAsNaira(milestonePayment.amountMinor)}<br />
                            <strong>Payment status:</strong>{' '}
                            <Badge variant={paymentStatusBadgeVariant(milestonePayment)}>
                                {paymentStatusLabel(milestonePayment)}
                            </Badge>
                            {!milestonePaymentIsConfirmed(milestonePayment) && (
                                <span className="ml-2 text-xs text-foreground-muted">
                                    Payment not yet confirmed
                                </span>
                            )}
                        </p>
                    ) : hasMilestonePaymentData ? (
                        <p className="mt-1 text-sm text-foreground-muted">
                            <strong>Payment status:</strong> Unavailable
                        </p>
                    ) : null}
                </>
            )}
            <p>
                <strong>Due:</strong> {dateLabel(task.dueDate)}
            </p>
            <p>
                <strong>Assigned:</strong> {dateLabel(task.createdDate)}
            </p>
            <p>
                <strong>Status:</strong>{' '}
                <Badge variant={taskStatusBadgeVariant(task)}>
                    {taskStatusBadgeLabel(task)}
                </Badge>
            </p>

            {/* STAGE 10G. Shown on every card, submittable or not: it is what decides
                which control is below, so an employee knows what is being asked of them
                before they reach it. */}
            <p>
                <strong>Deliver by:</strong> {taskSubmissionTypeLabel(task)}
            </p>

            {/* The employer's note is the instruction for the next submission, so it
                sits above the submit control, which only exists in this status. The
                message itself is only shown when the record carries one; a sent-back
                task with no note still says what happened rather than showing nothing. */}
            {status === 'revision_requested' && (
                <p
                    role="note"
                    style={{
                        background: '#fef3c7',
                        borderLeft: '4px solid #d97706',
                        padding: '8px 10px',
                        margin: '10px 0',
                    }}
                >
                    <strong>Changes requested:</strong>{' '}
                    {task.revisionNote || 'No feedback was provided with this change request.'}
                </p>
            )}

            {/* The submitted work stays readable after approval, so an employee can
                see what was delivered for the record. SubmittedWork picks the shape
                from the task's type and, for a text task, still reads `submittedBody`
                for everything submitted before Stage 10G. */}
            {(status === 'submitted' || status === 'approved') && <SubmittedWork task={task} />}

            {/* STAGE 10E-1. Only rendered in the "work not linked to a hire" section,
                where `readOnly` is set. Every field above is the same read-only
                information a normal card shows -- the note replaces the submit control,
                not any of it. */}
            {readOnly && (
                <p
                    role="note"
                    style={{
                        background: '#fef3c7',
                        borderLeft: '4px solid #d97706',
                        padding: '8px 10px',
                        margin: '10px 0',
                    }}
                >
                    <strong>This task cannot be submitted from here.</strong> It is not linked
                    to an employment, so the work-delivery workflow does not apply to it.
                    Contact the employer who assigned it if you need to deliver this work.
                </p>
            )}

            {canSubmit && !readOnly && (
                <>
                    <label
                        htmlFor={`submit-work-${task.id}`}
                        style={{ display: 'block', marginBottom: '4px' }}
                    >
                        <strong>Submit your work:</strong>
                    </label>

                    {/* STAGE 10G. One control per type, because the task's type is fixed
                        at creation and the server accepts only the field that matches it.
                        Rendering all three and hiding two would leave the employee able to
                        fill in something that cannot be submitted. */}
                    {submissionType === 'text' && (
                        <textarea
                            id={`submit-work-${task.id}`}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            disabled={isSubmitting}
                            rows={5}
                            placeholder="Paste or write the work you are delivering for this task."
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px' }}
                        />
                    )}

                    {submissionType === 'link' && (
                        <>
                            <input
                                id={`submit-work-${task.id}`}
                                type="url"
                                value={linkDraft}
                                onChange={(event) => setLinkDraft(event.target.value)}
                                disabled={isSubmitting}
                                placeholder="https://"
                                style={{ width: '100%', boxSizing: 'border-box', padding: '8px' }}
                            />
                            {linkLooksWrong && (
                                <p role="note" style={{ color: '#b45309', margin: '6px 0 0' }}>
                                    This must be a link starting with http:// or https://.
                                </p>
                            )}
                        </>
                    )}

                    {submissionType === 'file' && (
                        <>
                            {/* No `accept`: which files count is the employer's call, and
                                inventing a filter here would refuse deliveries on the
                                client's behalf. The name is shown back because a picker
                                cannot show more than the name. */}
                            <input
                                id={`submit-work-${task.id}`}
                                type="file"
                                onChange={(event) => setFileDraft(event.target.files?.[0] || null)}
                                disabled={isSubmitting}
                                style={{ display: 'block', width: '100%', boxSizing: 'border-box' }}
                            />
                            {fileDraft && (
                                <p style={{ margin: '6px 0 0' }}>
                                    <strong>Selected:</strong> {fileDraft.name}
                                </p>
                            )}
                        </>
                    )}

                    <Button
                        type="button"
                        onClick={submit}
                        disabled={isSubmitting || !hasDraft}
                        aria-busy={isSubmitting}
                        className="mt-2"
                    >
                        {isSubmitting ? 'Submitting...' : 'Submit work'}
                    </Button>
                </>
            )}

            {workflowError && (
                <p role="alert" style={{ color: '#dc2626', margin: '10px 0 0' }}>
                    {workflowError}
                </p>
            )}
            {notice && !workflowError && (
                <p role="status" style={{ color: '#15803d', margin: '10px 0 0' }}>
                    {notice}
                </p>
            )}
        </li>
    );
};

/**
 * STAGE 10E. The per-job task-progress summary.
 *
 * Derived, never stored: it is counted from the same task documents the cards below
 * it render, using the same `taskStatus` derivation the server uses, so the summary
 * and the individual cards can never disagree. There is no progress field on a job or
 * an employment document to read instead -- the counts would have to come from
 * somewhere, and the task list these views already fetch is the authority.
 *
 * Renders a sentence rather than a bar: a bar needs a total the server does not
 * store, so it would be this page inventing a denominator, and the four statuses are
 * not stages of one number anyway (a task awaiting a revision is not 50% done).
 */
export const TaskProgress = ({ tasks, tasksUnavailable }) => {
    if (tasksUnavailable) {
        return (
            <p style={{ margin: '10px 0' }}>
                <strong>Tasks:</strong> could not be loaded.
            </p>
        );
    }

    if (tasks.length === 0) {
        return (
            <p style={{ margin: '10px 0' }}>
                <strong>Tasks:</strong> none assigned for this job yet.
            </p>
        );
    }

    const counts = TASK_STATUS_ORDER.map((status) => ({
        status,
        count: tasks.filter((task) => taskStatus(task) === status).length,
    })).filter((entry) => entry.count > 0);

    return (
        <p style={{ margin: '10px 0' }}>
            <strong>Tasks:</strong> {tasks.length} assigned &mdash;{' '}
            {counts
                .map((entry) => `${entry.count} ${TASK_STATUS_LABELS[entry.status].toLowerCase()}`)
                .join(', ')}
        </p>
    );
};

export default TaskCard;