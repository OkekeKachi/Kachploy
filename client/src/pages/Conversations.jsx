import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { Link } from 'react-router-dom';
import { MessageSquare, AlertCircle } from 'lucide-react';
import { auth } from '../firebase';
import api from '../api';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';

/**
 * STAGE 10B: the signed-in user's message inbox, at /messages.
 *
 * This page used to be the inbox AND the reader: it listed the conversations and
 * expanded a ConversationThread underneath whichever row was selected. It is now the
 * LIST ONLY, and every row opens `/messages/:conversationId` -- a dedicated screen with
 * a header, the thread, and the composer. That split is the whole of this stage's
 * client work, and it was forced by three things that a combined page cannot do:
 *
 *   * An unread count is only meaningful if the reader can leave a thread unread and
 *     still see it. With the thread inline, selecting a row showed it, so there was no
 *     separate "opened" moment for the count to attach to.
 *   * A badge on the navbar has to point somewhere. There was no address for "the
 *     conversation with this person", only a piece of component state inside this page.
 *   * An application card and a thread are different jobs. ViewJobApplications renders
 *     one card per applicant; embedding a full thread in each is what forced the
 *     collapsed-by-default launcher and its per-card state in the first place.
 *
 * WHO AM I TALKING TO
 *   STAGE 8F. In Stage 8C each row could only state which side of the conversation the
 *   reader was on, because the Stage 8B conversation document carries `employerId` and
 *   `employeeId` and nothing else that identifies a person. That was honest but it made
 *   a list of conversations hard to read: an employer with four applicants on one job saw
 *   four identical rows differing only by a job title, and could not tell the rows apart
 *   at a glance.
 *
 *   The name now comes from GET /users/getUser/:userId, which already existed and was
 *   already readable by any signed-in caller -- userService.getUser returns the stored
 *   document for yourself and a projected public profile (fullName, profilePic,
 *   location, bio) for anyone else. So this is a join onto an EXISTING endpoint, not a
 *   new names API: nothing about the backend changed for it.
 *
 *   The join is keyed on knowing who the reader is. A conversation names two uids and
 *   only one of them is the reader, so the counterpart cannot be chosen until the auth
 *   session has resolved -- which is why the load below waits for `currentUserId` rather
 *   than firing on mount as it did in Stage 8C. Fetching early would mean guessing, and a
 *   guess here is not a cosmetic error: it labels every row with the wrong person.
 *
 * WHY NO APPLICANT-NAME LOOKUP, STILL
 *   The other way to reach an applicant's name is GET /applications/job/:jobId, which
 *   carries `fullName` on each application. It is employer-scoped, so the applicant would
 *   need different code entirely, and it would break for the withdrawn case where the
 *   application document no longer exists. The user join works identically for both
 *   roles and survives a withdrawn application, which is why it is the one used.
 *
 * WHAT EACH ROW SHOWS, AND WHERE EACH PIECE COMES FROM
 *   * WHO -- the join above.
 *   * THE JOB -- GET /jobs/:jobId, the same read Stage 8F did.
 *   * THE UNREAD COUNT -- `unreadCount` on the row, computed by the server from the
 *     messages newer than this reader's own marker. It is a count of messages RECEIVED,
 *     so a reader's own messages never make their inbox unread.
 *   * THE LAST MESSAGE -- `lastMessage` on the row, which the server supplies alongside
 *     the count because it was already reading those messages to count them. The server
 *     truncates the body (LAST_MESSAGE_PREVIEW_LENGTH) since this same response is what
 *     the navbar badge polls; a client that trusted the full length would be trusting a
 *     promise the API does not make.
 *
 * REST ONLY, AND WHY THIS LIST DOES NOT POLL. It is fetched once per visit, as in Stage
 * 8C, and that is now a firmer decision rather than a leftover: the unread count costs
 * the server one message query per conversation, so polling this list would multiply the
 * most expensive read in the resource by the number of rows on screen. The navbar badge
 * polls the same endpoint on a longer interval (see MessagesNavLink.jsx) and is the live
 * signal for "something arrived"; this page re-reads on every visit, including the
 * navigate-back-from-a-thread that is the one moment a count on screen can be stale.
 */

/*
    NO readErrorMessage HELPER HERE, unlike the four other files that read one of the
    server's messages. This page reports a fixed sentence instead, and that is
    deliberate rather than an omission: the only ways GET /conversations fails for a
    signed-in reader are a transport drop or a 5xx, and in both cases there is nothing
    the reader can do differently in response to the server's wording. HiredJobs.jsx
    already takes this approach for its task list ("Your tasks could not be loaded.
    Please reload the page to try again."), and matching it keeps the two list pages
    telling the reader the same kind of thing. The per-row name and job lookups below
    do NOT surface the server's message, for the same reason: a row that cannot name
    somebody degrades to a stated absence rather than an error.
*/

const CONVERSATIONS_ERROR = 'Your conversations could not be loaded. Please reload the page to try again.';

/*
    STAGE 11.14: the local style objects that used to live here (PAGE, CARD, UNREAD_CARD,
    ROW_TITLE, MUTED, ROLE_CHIP, UNREAD_BADGE, LAST_MESSAGE, ROW_BUTTON) are gone. Each
    was a hardcoded colour, radius, spacing or size that the design system now owns, so
    the elements below carry Tailwind utilities that resolve to the shared tokens
    instead. The 4px accent left edge that marked an unread row and the truncation that
    kept a 200-character preview to one line are kept, now as `border-l-4 border-l-accent`
    and `truncate`.
*/

/*
    STAGE 11.14: a <Link> styled as a Button, matching EmployeeWorkspace.jsx /
    HiredJobs.jsx / EmployeeJobTasks.jsx. The row's destination keeps anchor semantics
    (middle-click / open-in-new-tab) rather than becoming a <button>.
*/
const ActionLink = ({ to, variant = 'secondary', className = '', children }) => {
    const variants = {
        primary: 'border-transparent bg-accent text-foreground-inverse hover:bg-accent-hover',
        secondary: 'border-border-strong bg-surface text-foreground hover:bg-surface-muted',
    };

    return (
        <Link
            to={to}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${variants[variant]} ${className}`}
        >
            {children}
        </Link>
    );
};

/*
    STAGE 10B. One preview line: the newest message, and when it was sent.

    `toDate` is a local copy of the same decoder ConversationThread.jsx holds, for the
    reason that file documents and MyApplications.jsx documents again: each of these
    files keeps its own copy and there is deliberately no shared module for it. A shared
    one would be the better engineering choice and is still not this stage's change to
    make -- the third copy is smaller than the refactor that would remove the first two.
*/
const toDate = (value) => {
    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        const fromTimestamp = new Date(value._seconds * 1000);
        return Number.isNaN(fromTimestamp.getTime()) ? null : fromTimestamp;
    }

    if (typeof value === 'string' && value) {
        const fromString = new Date(value);
        return Number.isNaN(fromString.getTime()) ? null : fromString;
    }

    return null;
};

/**
 * When the last message was sent, or an empty string when it cannot be decoded.
 *
 * Unlike the thread's per-message label this includes the DATE as well as the time. A
 * row is read days after it was written far more often than a message is, so "14:32"
 * alone would be ambiguous on every row older than today.
 */
const lastMessageLabel = (lastMessage) => {
    const date = lastMessage ? toDate(lastMessage.createdAt) : null;
    if (!date) return '';

    return date.toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
};

const Conversations = () => {
    const [conversations, setConversations] = useState([]);
    const [jobsById, setJobsById] = useState({});
    const [namesById, setNamesById] = useState({});
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [currentUserId, setCurrentUserId] = useState(null);
    // STAGE 11.14: identity for the shared AppNavbar, taken from the auth session the
    // onAuthStateChanged callback already delivers. Presentation only -- no user
    // document read is added by this page; AppNavbar resolves the missing `role`
    // from its own single, session-cached read, so the full role entry set still
    // renders there, exactly as the other redesigns do.
    const [navUser, setNavUser] = useState({});

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setCurrentUserId(user ? user.uid : null);
            setNavUser({ fullName: (user && user.displayName) || '', email: (user && user.email) || '' });
        });

        return () => unsubscribe();
    }, []);

    /*
        STAGE 8C. GET /conversations takes no identifier: the service takes the uid from
        the verified token and issues two single-field queries (one as employer, one as
        employee) and unions them, so this page cannot ask for anyone else's inbox even
        by constructing a different URL. No new authorization decision is made here.
    */
    const fetchConversations = useCallback(async () => {
        setLoading(true);
        setLoadError('');

        try {
            const res = await api.get('/conversations');
            const list = Array.isArray(res.data.conversations) ? res.data.conversations : [];
            setConversations(list);

            const jobIds = [...new Set(list.map((c) => c.jobId).filter(Boolean))];

            /*
                STAGE 8F. The counterpart for each row is whichever of the two stored uids
                is not the reader's -- which is only knowable once `currentUserId` is
                resolved, and is why this effect depends on it.
            */
            const counterpartUids = [
                ...new Set(
                    list
                        .map((c) => (c.employerId === currentUserId ? c.employeeId : c.employerId))
                        .filter(Boolean)
                ),
            ];

            /*
                STAGE 8F. Job titles and counterpart names in ONE parallel batch.

                Both are N+1 over the inbox, so both are deduplicated to DISTINCT ids
                first -- an employer with four applicants on one job then costs one job
                read and four name reads, not eight reads of the same two documents.
                Issuing them concurrently rather than in sequence makes the wall-clock
                cost one round trip instead of N, which is the arrangement MyApplications
                already uses for its interview reads.

                Both are also isolated per id. A failed read resolves that entry to null
                and nothing else, so one deleted job -- or one user with no profile name --
                degrades a single row rather than emptying the inbox. This is the same
                rule Stage 8E established for a conversation that outlives its job.

                STAGE 10B: this is the only N+1 on the page now that the server resolves
                the preview and the count itself. Two of the three joins a row used to
                need are gone from the client, and what is left is the two the server
                cannot answer.
            */
            const [titles, names] = await Promise.all([
                Promise.all(
                    jobIds.map(async (jobId) => {
                        try {
                            const jobRes = await api.get(`/jobs/${jobId}`);
                            return [jobId, jobRes.data.job || null];
                        } catch (err) {
                            console.error(`Error fetching job ${jobId} for the conversation list:`, err);
                            return [jobId, null];
                        }
                    })
                ),
                Promise.all(
                    counterpartUids.map(async (uid) => {
                        try {
                            const userRes = await api.get(`/users/getUser/${uid}`);
                            const user = userRes.data ? userRes.data.user : null;
                            return [uid, user && typeof user.fullName === 'string' ? user.fullName.trim() : null];
                        } catch (err) {
                            console.error(`Error fetching the name of user ${uid}:`, err);
                            return [uid, null];
                        }
                    })
                ),
            ]);

            setJobsById(Object.fromEntries(titles));
            setNamesById(Object.fromEntries(names));
        } catch (err) {
            console.error('Error fetching conversations:', err);
            setConversations([]);
            setLoadError(CONVERSATIONS_ERROR);
        } finally {
            setLoading(false);
        }
    }, [currentUserId]);

    /*
        STAGE 8F: gated on the auth session resolving.

        Stage 8C fired this on mount and labelled rows afterwards, which produced a
        visible flash of "Applicant" on every row for an employer until the listener
        returned. It could not simply keep doing that, because the counterpart uid is now
        derived FROM `currentUserId` -- so the load has to wait for it. The alternative,
        fetching first and joining once the uid arrives, would mean a second pass over the
        list and a second round of requests.

        `currentUserId` is null before the listener fires and stays null if the user signs
        out. The page is behind ProtectedRoute, so "still null" means "the session has not
        resolved yet" rather than "signed out", and the loading state below is the honest
        rendering of that. No conversation is fetched for a reader whose identity is
        unknown, which is also what stops this page from ever labelling a row with the
        wrong person's name.
    */
    /*
        STAGE 10B: fetched once, on arrival, and NOT polled.

        The two places that need to stay current do poll -- the navbar badge every 15s and
        an open thread every 5s -- and this page shows the badge's number anyway, because
        the navbar is on screen here too. So a reader waiting for a reply still gets the
        signal that something arrived; what they do not get is the row content and the
        per-row counts updating under them.

        That is a deliberate trade, not an oversight. Polling this list would re-read every
        conversation in the inbox (one message query each, server-side) plus a job and a
        profile lookup per distinct id, on every tick, for a page most readers visit for a
        few seconds. Reloading, or navigating back to it, is the refresh.

        Same open question as the badge, for the same reason: both want fresh counts from
        the one endpoint that produces them, and two pollers would double the same bill.
    */
    useEffect(() => {
        if (currentUserId) fetchConversations();
    }, [currentUserId, fetchConversations]);

    // STAGE 11.14: the shared full-screen loader, matching every other redesign.
    if (loading) {
        return <PageLoader label="Loading conversations…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <PageHeader title="Messages" className="mb-6" />

                {loadError && (
                    <div
                        role="alert"
                        className="mb-6 flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                    >
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{loadError}</span>
                    </div>
                )}

                {/*
                    STAGE 8F: the "no conversations" empty state.

                    The Stage 8C wording said only that there were none. This one says where
                    they come from, because the actionable next step for a reader who has
                    never messaged anyone is not obvious from an empty list -- conversations
                    are not something they create directly, they open one by contacting a
                    job. Both roles are named because both land on this page with none.
                */}
                {!loadError && conversations.length === 0 && (
                    <EmptyState
                        icon={MessageSquare}
                        title="No conversations yet"
                        description="Open one from any of your applications, or when an employer messages you about a job you applied to."
                    />
                )}

                {!loadError && conversations.length > 0 && (
                    <ul className="list-none space-y-3 p-0">
                        {conversations.map((conversation) => {
                            const job = jobsById[conversation.jobId];
                            const jobTitle = job ? job.title : null;

                            const isEmployer = currentUserId != null && conversation.employerId === currentUserId;
                            const counterpartUid = isEmployer ? conversation.employeeId : conversation.employerId;
                            const counterpartName = namesById[counterpartUid] || null;

                            /*
                                STAGE 8F. The headline is the PERSON, because that is what
                                distinguishes two conversations about the same job. The job is
                                the secondary line, and either can be missing independently --
                                a conversation outlives its job (Stage 8E) and a user may have
                                no profile name -- so each is rendered only when it resolved,
                                with an explicit sentence when it did not. An earlier version
                                collapsed both into one label, which meant one missing value
                                silently blanked the other and the row read as if neither
                                existed.
                            */
                            const headline = counterpartName
                                || (isEmployer ? 'Applicant' : 'Employer');
                            const hasHeadlineName = counterpartName != null;

                            /*
                                STAGE 10B. The count is read defensively rather than with a
                                default of 0 alone: `Number(...)` also turns a server that
                                sent nothing into 0, and the `> 0` test means a row can never
                                render a badge for a count it does not have.
                            */
                            const unreadCount = Number.isFinite(Number(conversation.unreadCount))
                                ? Number(conversation.unreadCount)
                                : 0;

                            const lastMessage = conversation.lastMessage || null;
                            const sentAt = lastMessageLabel(lastMessage);

                            return (
                                <Card
                                    as="li"
                                    key={conversation.id}
                                    className={`p-4 ${unreadCount > 0 ? 'border-l-4 border-l-accent' : ''}`}
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-base font-semibold text-foreground">{headline}</span>
                                        {unreadCount > 0 && <Badge variant="primary">{unreadCount}</Badge>}
                                    </div>

                                    {!hasHeadlineName && (
                                        <p className="mt-1 text-xs text-foreground-subtle">
                                            This participant has no name on their profile.
                                        </p>
                                    )}

                                    {jobTitle ? (
                                        <p className="mt-1 text-sm text-foreground-muted">
                                            <strong className="font-semibold text-foreground">Re:</strong> {jobTitle}
                                        </p>
                                    ) : (
                                        <p className="mt-1 text-xs text-foreground-subtle">
                                            The related job is no longer available.
                                        </p>
                                    )}

                                    {/*
                                        STAGE 10B. The newest message, one line, with who sent
                                        it. A row that has never been written in says so
                                        instead of showing nothing at all, because "no
                                        messages" is itself the reason a reader opens a row.
                                        `lastMessage.body` is already truncated by the server,
                                        and `truncate` keeps a 200-character preview from
                                        taking over the card.
                                    */}
                                    {lastMessage ? (
                                        <p className="mt-1 truncate text-xs text-foreground-subtle">
                                            <strong className="font-semibold text-foreground-muted">
                                                {lastMessage.senderId === currentUserId ? 'You' : headline}
                                                {sentAt && ` · ${sentAt}`}
                                            </strong>
                                            {' — '}
                                            {lastMessage.body}
                                        </p>
                                    ) : (
                                        <p className="mt-1 text-xs text-foreground-subtle">
                                            No messages yet.
                                        </p>
                                    )}

                                    <div className="mt-2">
                                        <Badge variant="neutral">
                                            You are the {isEmployer ? 'employer' : 'applicant'}
                                        </Badge>
                                    </div>

                                    <div className="mt-3 flex flex-wrap items-center gap-4">
                                        {/*
                                            STAGE 8C: "return to the relevant context where
                                            existing routes make that straightforward".
                                            /jobs/:jobId is the one job route that exists and
                                            is readable by both roles, so it works from either
                                            side of the list. The employer-side applicant
                                            review route
                                            (/employer/jobs/:jobId/applications/:jobTitle) was
                                            deliberately NOT used: it requires a :jobTitle
                                            segment, which this page would have to invent or
                                            fetch, and a wrong value would produce a link that
                                            renders but resolves to nothing. An applicant has no
                                            equivalent employer route at all.

                                            STAGE 8F: unchanged and still the context link for
                                            both roles. It is hidden only when the job is gone,
                                            since a link to a deleted job would resolve to
                                            nothing and read as a broken page.
                                        */}
                                        {jobTitle && (
                                            <Link
                                                to={`/jobs/${conversation.jobId}`}
                                                className="text-sm font-medium text-accent hover:underline"
                                            >
                                                View this job
                                            </Link>
                                        )}

                                        {/*
                                            STAGE 10B. The row's own action is a LINK to
                                            /messages/:conversationId rather than a button that
                                            expanded state inside this page, which is what makes
                                            the thread addressable: the navbar, an application card
                                            and this list all arrive at the same URL, and a reader
                                            can bookmark or share it.

                                            Deliberately not a link wrapped around the whole row.
                                            That would nest this <Link> inside another one, which
                                            is invalid HTML, and it would swallow the "View this
                                            job" link above -- two nested destinations, one of them
                                            silently unreachable.
                                        */}
                                        <ActionLink to={`/messages/${conversation.id}`} variant="secondary">
                                            Open conversation
                                        </ActionLink>
                                    </div>
                                </Card>
                            );
                        })}
                    </ul>
                )}
            </PageContainer>
        </div>
    );
};

export default Conversations;