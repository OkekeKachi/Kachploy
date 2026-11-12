import React, { useRef, useState } from 'react';
import api from '../api';
import { SubmittedWork } from './TaskCard';
import Badge from './ui/Badge';
import Button from './ui/Button';
import {
    dateLabel,
    taskStatus,
    taskStatusBadgeLabel,
    taskStatusBadgeVariant,
} from './taskPresentation';

/**
 * STAGE 10H.4.2. The employer side of the work-delivery loop, extracted from
 * ViewJobApplications.jsx (where it was a private component from Stage 9D) so that
 * the per-job application page and the per-employment workspace
 * (pages/EmployeeWorkspace.jsx) review work through ONE implementation. Two copies
 * would be two places to keep the "only `submitted` is reviewable" rule, the
 * synchronous double-click guard and the refresh-failure wording in agreement; the
 * workspace already renders the same SubmittedWork the employee does, and this keeps
 * the review actions on the same footing.
 *
 * Both controls appear only in `submitted`, which is the one status the server
 * accepts a transition from. `assigned` has nothing to review yet, and
 * `revision_requested` is waiting on the employee, so offering either control there
 * would offer a request the server answers with 400.
 *
 * `refreshTask` re-reads the changed task through GET /tasks/:taskId, the endpoint
 * Stage 9C added for exactly this read, rather than refetching every task on the job
 * or patching the card from the response body. It reports success as a boolean so a
 * failed refresh cannot be reported as a failed review: the review has already been
 * recorded by then and the employer is told so either way.
 *
 * The note is collected before the request is sent, not after. A note is the whole
 * content of a revision request, so it is never a leftover from a previous request:
 * it is cleared on open, on submit, and on cancel.
 *
 * `heading` defaults to the list title this panel has always rendered. A caller that
 * supplies its own title (the workspace shows one with a task count) passes
 * `heading={null}` and only the list is rendered.
 */
const TaskReviewPanel = ({ tasks, refreshTask, heading = 'Tasks' }) => {
    const [pendingAction, setPendingAction] = useState(null);
    const [revisionNote, setRevisionNote] = useState('');
    // STAGE 10H.4.3: the outcome is stored AGAINST THE TASK it belongs to
    // (`{ taskId, message }`), not as one panel-wide string. The panel renders one
    // <li> per task, so a bare string read back inside every item made the "sent back
    // for changes" confirmation appear on tasks the action never touched.
    const [workflowError, setWorkflowError] = useState(null);
    const [notice, setNotice] = useState(null);

    // STAGE 9D. Same synchronous double-click guard as `hiringInFlightRef` and
    // `clearingInFlightRef` in ViewJobApplications.jsx, and for the same reason:
    // isRequesting alone reads the pre-update render, so two clicks in one tick would
    // both reach the server. One ref covers approve and request-revision together
    // because both mutate the same task document -- letting an employer approve and
    // send back in parallel would race two statuses onto one task.
    const reviewInFlightRef = useRef(false);
    const [isReviewing, setIsReviewing] = useState(false);

    const openRevisionNote = (taskId) => {
        setPendingAction(taskId);
        setRevisionNote('');
        setWorkflowError(null);
        setNotice(null);
    };

    const cancelRevisionNote = () => {
        setPendingAction(null);
        setRevisionNote('');
    };

    const review = async (taskId, action) => {
        if (reviewInFlightRef.current) return;
        reviewInFlightRef.current = true;
        setIsReviewing(true);
        setWorkflowError(null);
        setNotice(null);

        try {
            const request = action === 'approve'
                ? api.post(`/tasks/${taskId}/approve`)
                : api.post(`/tasks/${taskId}/request-revision`, { revisionNote });

            await request;

            // The note is cleared only for the request it was written for. Approving a
            // different task on the same card must not close a note that is open and
            // partly typed here, so this is not unconditional.
            if (action === 'request-revision') {
                setPendingAction(null);
                setRevisionNote('');
            }

            const refreshed = await refreshTask(taskId);
            const outcome = action === 'approve' ? 'approved' : 'sent back for changes';
            setNotice({
                taskId,
                message: refreshed
                    ? `This task was ${outcome}.`
                    : `This task was ${outcome}, but it could not be refreshed -- reload the page to see its current status.`,
            });
        } catch (err) {
            // STAGE 9D: the server's message is kept, because it distinguishes the
            // three failures an employer can actually hit here -- not your
            // employment, not your task, and not reviewable from this status.
            console.error('Error reviewing task:', err);
            setWorkflowError({
                taskId,
                message: `This task was not ${action === 'approve' ? 'approved' : 'sent back'}: ${err.message || 'the request failed'}.`,
            });
        } finally {
            reviewInFlightRef.current = false;
            setIsReviewing(false);
        }
    };

    // A job can carry tasks for more than one hired employee, so a card that has
    // none renders nothing rather than a note about work that was never assigned.
    if (!tasks || tasks.length === 0) return null;

    return (
        <div style={{ borderTop: heading ? '1px solid #e5e7eb' : 'none', marginTop: heading ? '12px' : 0, paddingTop: heading ? '10px' : 0 }}>
            {heading && <h5 style={{ margin: '0 0 8px' }}>{heading}</h5>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {tasks.map((task) => {
                    const status = taskStatus(task);
                    const isReviewable = status === 'submitted';
                    const isNoteOpen = pendingAction === task.id;
                    // STAGE 10H.4.3: only the task named by the outcome shows it. A
                    // message set for a different task renders nothing here, so a
                    // revision request on one card cannot report itself on another.
                    const taskError = workflowError && workflowError.taskId === task.id ? workflowError.message : '';
                    const taskNotice = notice && notice.taskId === task.id ? notice.message : '';

                    return (
                        <li
                            key={task.id}
                            style={{
                                border: '1px solid #e5e7eb',
                                borderRadius: '8px',
                                padding: '10px',
                                marginBottom: '8px',
                            }}
                        >
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>{task.taskName}</strong>
                            </p>
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>Description:</strong>{' '}
                                {task.taskDescription || 'No description'}
                            </p>
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>Due:</strong> {dateLabel(task.dueDate)}
                            </p>
                            <p style={{ margin: '0 0 6px' }}>
                                <strong>Status:</strong>{' '}
                                <Badge variant={taskStatusBadgeVariant(task)}>
                                    {taskStatusBadgeLabel(task)}
                                </Badge>
                            </p>

                            {/* STAGE 10G: the note sent back, and the work it was sent back
                                about. Both are shown, because a revision request
                                that hides the work it refers to leaves the
                                employee nothing to act on. SubmittedWork renders
                                whichever of the three shapes was delivered, and
                                returns nothing when there is none -- which is why
                                the `&&` this replaced is no longer needed.
                                A record carrying no note still reports that the
                                task was sent back rather than going silent. */}
                            {status === 'revision_requested' && (
                                <>
                                    <p style={{ margin: '0 0 6px', color: '#b45309' }}>
                                        <strong>Note sent back:</strong>{' '}
                                        {task.revisionNote ||
                                            'No feedback was provided with this change request.'}
                                    </p>
                                    <SubmittedWork task={task} />
                                </>
                            )}
                            {status === 'approved' && (
                                <SubmittedWork
                                    task={task}
                                    label="Approved work"
                                    fallback="No submitted work was recorded."
                                />
                            )}

                            {isReviewable && (
                                <>
                                    {/* STAGE 9D: the work under review, above the
                                        controls. Approving is approving THIS work, so
                                        it has to be readable in the same view as
                                        the button that approves it. */}
                                    <SubmittedWork
                                        task={task}
                                        fallback="No submitted work was recorded."
                                    />

                                    {!isNoteOpen ? (
                                        <>
                                            <Button
                                                type="button"
                                                onClick={() => review(task.id, 'approve')}
                                                disabled={isReviewing}
                                                aria-busy={isReviewing}
                                                className="mr-2"
                                            >
                                                Approve
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={() => openRevisionNote(task.id)}
                                                disabled={isReviewing}
                                            >
                                                Request revision
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            <label
                                                htmlFor={`revision-note-${task.id}`}
                                                style={{ display: 'block', marginBottom: '4px' }}
                                            >
                                                <strong>What needs to change:</strong>
                                            </label>
                                            <textarea
                                                id={`revision-note-${task.id}`}
                                                value={revisionNote}
                                                onChange={(event) => setRevisionNote(event.target.value)}
                                                disabled={isReviewing}
                                                rows={3}
                                                placeholder="Explain what the employee needs to change."
                                                style={{ width: '100%', boxSizing: 'border-box', padding: '8px' }}
                                            />
                                            <Button
                                                type="button"
                                                onClick={() => review(task.id, 'request-revision')}
                                                disabled={isReviewing || revisionNote.trim().length === 0}
                                                aria-busy={isReviewing}
                                                className="mr-2 mt-2"
                                            >
                                                {isReviewing ? 'Sending...' : 'Send back for changes'}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={cancelRevisionNote}
                                                disabled={isReviewing}
                                                className="mt-2"
                                            >
                                                Cancel
                                            </Button>
                                        </>
                                    )}
                                </>
                            )}

                            {taskError && (
                                <p role="alert" style={{ color: '#dc2626', margin: '8px 0 0' }}>
                                    {taskError}
                                </p>
                            )}
                            {taskNotice && !taskError && (
                                <p role="status" style={{ color: '#15803d', margin: '8px 0 0' }}>
                                    {taskNotice}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

export default TaskReviewPanel;
