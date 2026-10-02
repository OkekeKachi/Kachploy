import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';

/**
 * STAGE 6C: the real destination behind the "View Your Hired Jobs" call to action
 * that MyApplications.jsx has always shown to an applicant whose application was
 * accepted.
 *
 * Until this stage that call to action pointed at `/employee/hired-jobs`, a path
 * that no route ever matched: it was a raw `<a href>`, so it also reloaded the
 * whole document into an empty view. The congratulations were real and the link
 * was a dead end.
 *
 * WHY THIS PAGE CANNOT SHOW ANOTHER EMPLOYEE'S TASKS
 *   The route takes no identifier at all. There is no `:uid`, no query string and
 *   no prop -- the employee is read from the verified auth session, so there is
 *   nothing in the URL for a caller to edit. Two further layers back that up:
 *     * `protect` on the route in App.jsx requires a signed-in user
 *     * GET /tasks/employee/:uid is guarded server-side by requireSelfParam,
 *       which 403s unless the path uid equals req.user.uid from the verified
 *       token
 *   Even a hand-edited request for someone else's uid is refused by the server,
 *   and this page renders nothing until that call succeeds.
 *
 * STAGE 6B added the read endpoint; this stage only consumes it. There is no
 * task editing, completion or deletion here, and no new backend route.
 */

/**
 * Decodes the two date shapes that reach this page.
 *
 * STAGE 6B stores `dueDate` as the ISO string ViewJobApplications.jsx sends
 * (`new Date().toISOString()`), and `createdDate` as a Firestore Timestamp, which
 * arrives as `{_seconds, _nanoseconds}` -- the same wire shape the 5H decoders in
 * ViewJobApplications.jsx and JobSplitView.jsx already handle. Both branches are
 * needed here because one page reads one of each.
 *
 * Mirrors appliedOnLabel: every input, including undefined, yields a string, so a
 * malformed date can never throw and take the list down with it.
 */
const dateLabel = (value) => {
    let date;

    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        date = new Date(value._seconds * 1000);
    } else if (typeof value === 'string' && value) {
        date = new Date(value);
    }

    return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Date not available';
};

const HiredJobs = () => {
    const [tasks, setTasks] = useState([]);
    // jobId -> job, joined from the employee's own applications so the task cards
    // can name the work. null when the application list could not be read, which
    // is why it is tracked separately from `tasks`.
    const [jobsById, setJobsById] = useState({});
    const [jobsUnavailable, setJobsUnavailable] = useState(false);
    const [loading, setLoading] = useState(true);
    // STAGE 5I-1 convention: the failure is shown to the user, not only logged.
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                // ProtectedRoute normally turns an anonymous visitor away, but the
                // session can still resolve empty after that render.
                if (!cancelled) setLoading(false);
                return;
            }

            try {
                const res = await api.get(`/tasks/employee/${user.uid}`);
                if (cancelled) return;
                setTasks(res.data.tasks || []);
                setError('');
            } catch (err) {
                console.error('Error fetching tasks:', err);
                if (cancelled) return;
                setError('Your tasks could not be loaded. Please reload the page to try again.');
            } finally {
                if (!cancelled) setLoading(false);
            }

            // The job details are enrichment, not the page's reason to exist, so a
            // failure here is recorded but does not replace the task list or the
            // error above. Each task still carries the jobId it belongs to.
            try {
                const appsRes = await api.get(`/applications/employee/${user.uid}`);
                if (cancelled) return;

                const joined = {};
                (appsRes.data.applications || []).forEach((app) => {
                    if (app.jobId && app.job) joined[app.jobId] = app.job;
                });
                setJobsById(joined);
            } catch (err) {
                console.error('Error fetching job details for tasks:', err);
                if (!cancelled) setJobsUnavailable(true);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    if (loading) {
        return <p>Loading...</p>;
    }

    return (
        <div style={{ padding: '20px' }}>
            <h2>Your Hired Jobs</h2>

            {error && (
                <p role="alert" style={{ color: '#dc2626', marginBottom: '12px' }}>
                    {error}
                </p>
            )}

            {tasks.length === 0 ? (
                <div>
                    <p>You have no assigned tasks yet.</p>
                    <p>
                        Tasks appear here once an employer hires you for a job and assigns
                        work to you.
                    </p>
                    <Link to="/my-applications">Back to my applications</Link>
                </div>
            ) : (
                <>
                    {jobsUnavailable && (
                        <p role="alert" style={{ color: '#b45309', marginBottom: '12px' }}>
                            Job details could not be loaded, so tasks are listed without them.
                        </p>
                    )}
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                        {tasks.map((task) => {
                            const job = jobsById[task.jobId];

                            return (
                                <li
                                    key={task.id}
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
                                        <strong>Description:</strong>{' '}
                                        {task.taskDescription || 'No description'}
                                    </p>
                                    <p>
                                        <strong>Due:</strong> {dateLabel(task.dueDate)}
                                    </p>
                                    <p>
                                        <strong>Assigned:</strong> {dateLabel(task.createdDate)}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                    <Link to="/my-applications">Back to my applications</Link>
                </>
            )}
        </div>
    );
};

export default HiredJobs;