import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { auth } from '../firebase';
import api from '../api';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import ConversationThread from '../components/ConversationThread';

/**
 * STAGE 10B: one conversation, at /messages/:conversationId.
 *
 * This screen is what Stage 8C could not offer. The thread used to be a component
 * rendered INSIDE something else -- an application card, or a row of the inbox -- which
 * meant it had no address, so it could not be linked to, could not be reached from the
 * navbar, and had no moment at which "the reader opened it" could be reported to the
 * server. The URL is what makes all three possible, and this page is what the URL
 * resolves to.
 *
 * IT IS A PAGE, NOT A PARAMETER OF THE INBOX
 *   `/messages` and `/messages/:conversationId` are separate routes rather than one page
 *   with a selected id, and the difference is not cosmetic: an unread count is only
 *   meaningful if a thread can be left unread, so selecting a row must not be the same
 *   act as reading it. With the two on one route the back button, a refresh and a shared
 *   link would all have to restore "which row is open" from component state, and the
 *   server would have to be told separately which conversation was on screen. A route
 *   carries that in the address, which is why the mark-read call below can be a plain
 *   function of where you are.
 *
 * WHAT IT HAS TO RESOLVE BEFORE IT CAN RENDER A HEADER
 *   A conversation names two uids and a job id, and no names. So the header needs three
 *   reads that the conversation document alone cannot answer, and all three are EXISTING
 *   endpoints -- this stage added no names API and no jobs API:
 *
 *     GET /conversations/:id     who the two participants are, and which job this is
 *     GET /users/getUser/:uid    the counterpart's display name
 *     GET /jobs/:jobId           the job title for the caption
 *
 *   The user join is the same one Conversations.jsx and ConversationLauncher.jsx already
 *   used, and for the same reason: userService.getUser returns a public profile for
 *   anyone else, so it is readable by both roles and survives a withdrawn application,
 *   which the employer-scoped /applications/job/:jobId join would not.
 *
 *   Each of the two joins FAILS SOFTLY, on purpose. A conversation outlives its job
 *   (Stage 8E) and a user may have no profile name, so "no title" and "no name" are
 *   reachable states rather than hypotheticals. ConversationThread already renders a
 *   stated fallback for each; this page passes null through and lets it, because the
 *   alternative -- turning a failed cosmetic lookup into an error state -- would take
 *   away a working conversation because of a label.
 *
 * MARKING READ, AND WHY IT IS NOT DONE ONCE ON MOUNT
 *   Opening the thread is the mark-read moment, and this page calls
 *   PUT /conversations/:conversationId/read for it. But "on mount" alone is not enough,
 *   and the reason is specific: the thread re-reads itself every five seconds, so a
 *   message can arrive while the reader is SITTING AND READING IT. Marking only on mount
 *   would leave the navbar badge lit over a thread whose newest message the reader is
 *   looking at, which is the kind of badge people learn to ignore.
 *
 *   So the mark follows the newest message from the other participant, not the mount.
 *   `onMessagesLoaded` reports the loaded thread; the newest incoming message's id is
 *   compared with the one last marked, and a write happens only when it differs. That
 *   costs at most one write per new incoming message and ZERO writes on every poll that
 *   brought nothing -- which is the common case. Marking on every successful load instead
 *   would be a write every five seconds for as long as the page is open.
 *
 *   The mark is silent on failure. It is a convenience for the reader's own benefit; a
 *   failed write means their next inbox shows a conversation as unread that they have in
 *   fact read, which is a stale number rather than a broken screen. The thread's own
 *   errors are still shown -- they are about messages, not about this.
 */

/*
    STAGE 11.14: the local style objects that used to live here (PAGE, BACK_LINK,
    HEADING, MUTED) are gone. Each was a hardcoded colour, spacing or size the design
    system now owns, so the elements below carry Tailwind utilities that resolve to the
    shared tokens instead.
*/

/*
    STAGE 11.14: a <Link> styled as a Button, matching EmployeeWorkspace.jsx /
    HiredJobs.jsx / EmployeeJobTasks.jsx. The "Back to messages" destination keeps
    anchor semantics (middle-click / open-in-new-tab) rather than becoming a <button>.
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

const CONVERSATION_ERROR = 'This conversation could not be loaded. It may have been removed, or you may not have access to it.';

/*
    A local copy of the same decoder Conversations.jsx and ConversationThread.jsx each
    hold, for the reason those files document: these components keep their own copies
    and there is deliberately no shared module for it. This page needs it for the "last
    message" line in its header, which is a fact about the conversation rather than about
    the thread.
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

const lastMessageLabel = (value) => {
    const date = toDate(value);
    if (!date) return '';

    return date.toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
};

const ConversationPage = () => {
    const { conversationId } = useParams();

    const [conversation, setConversation] = useState(null);
    const [currentUserId, setCurrentUserId] = useState(null);
    const [counterpartName, setCounterpartName] = useState(null);
    const [contextLabel, setContextLabel] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    /*
        STAGE 10B. Whether the session has been READ yet, tracked separately from the uid
        itself -- because "not known yet" and "known to be nobody" are different states and
        only the first one is temporary.

        Waiting for it matters twice over here, and both times it is about acting on a
        guess:

          * The header. Which participant is "the other one" is decided by comparing the
            reader's uid against `employerId`. With no uid yet, every reader would look
            like an applicant, so an employer landing on this URL would briefly be shown
            their own name as the person they are messaging, then have it corrected a
            moment later.
          * The mark-read. "Newest message that is not mine" needs the uid. With no uid,
            `senderId !== null` is true of everything, so the newest message of all --
            including the reader's own -- would be taken as the newest incoming one and
            written as the mark-read trigger.
    */
    const [authReady, setAuthReady] = useState(false);
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
            setAuthReady(true);
        });

        return () => unsubscribe();
    }, []);

    /*
        STAGE 10B. Load the conversation, then join the two labels off it.

        Sequential rather than parallel on purpose: the counterpart uid and the job id
        both come FROM the conversation, so there is nothing to fetch until it has
        arrived, and firing them first would mean fetching every conversation the reader
        has -- which is the inbox, and costs one message query per conversation.

        The two joins then run together, because they are independent of each other.
    */
    const fetchConversation = useCallback(async () => {
        // Held until the session resolves -- see the note on `authReady` above.
        if (!conversationId || !authReady) return;

        setLoading(true);
        setLoadError('');

        try {
            const res = await api.get(`/conversations/${conversationId}`);
            const loaded = res.data ? res.data.conversation : null;

            if (!loaded) {
                setConversation(null);
                setLoadError(CONVERSATION_ERROR);
                return;
            }

            setConversation(loaded);

            /*
                Who the other participant is cannot be decided until the reader's own uid
                is known -- the same constraint Conversations.jsx documents. Both roles can
                land on this URL, so there is no role branch to take instead.
            */
            const isEmployer = currentUserId != null && loaded.employerId === currentUserId;
            const counterpartUid = isEmployer ? loaded.employeeId : loaded.employerId;

            const [nameResult, jobResult] = await Promise.all([
                counterpartUid
                    ? api.get(`/users/getUser/${counterpartUid}`).catch((err) => {
                        console.error(`Error loading the display name for user ${counterpartUid}:`, err);
                        return null;
                    })
                    : null,
                loaded.jobId
                    ? api.get(`/jobs/${loaded.jobId}`).catch((err) => {
                        console.error(`Error loading job ${loaded.jobId} for the conversation header:`, err);
                        return null;
                    })
                    : null,
            ]);

            const user = nameResult && nameResult.data ? nameResult.data.user : null;
            const name = user && typeof user.fullName === 'string' ? user.fullName.trim() : null;
            setCounterpartName(name || null);

            const job = jobResult && jobResult.data ? jobResult.data.job : null;
            setContextLabel(job && typeof job.title === 'string' ? job.title : null);
        } catch (err) {
            console.error(`Error fetching conversation ${conversationId}:`, err);
            setConversation(null);
            setLoadError(CONVERSATION_ERROR);
        } finally {
            setLoading(false);
        }
    }, [conversationId, currentUserId, authReady]);

    useEffect(() => {
        fetchConversation();
    }, [fetchConversation]);

    /*
        The mark-read throttle described at the top of this file.

        A ref rather than state on purpose: it is bookkeeping for "have I already told the
        server about this message", and nothing renders from it. Putting it in state would
        cost a re-render of the whole thread on every poll that found something new, for a
        value no element displays.
    */
    const lastMarkedMessageIdRef = useRef(null);

    const markReadFor = useCallback(async (messages) => {
        if (!Array.isArray(messages)) return;

        const newestFromCounterpart = [...messages]
            .reverse()
            .find((message) => message.senderId !== currentUserId);

        if (!newestFromCounterpart) return;
        if (lastMarkedMessageIdRef.current === newestFromCounterpart.id) return;

        lastMarkedMessageIdRef.current = newestFromCounterpart.id;

        try {
            await api.put(`/conversations/${conversationId}/read`);
        } catch (err) {
            /*
                Deliberately not surfaced. The thread is readable and writable regardless,
                and the worst outcome of a failed mark is that this conversation shows as
                unread in the list -- which the reader can fix by opening it again. A red
                banner over a working thread would be a worse trade than a stale number.

                The id is NOT rolled back on failure: retrying the same message on every
                subsequent poll would turn one failed write into a failing request every
                five seconds. The next genuinely new message will try again.
            */
            console.error('Error marking the conversation as read:', err);
        }
    }, [conversationId, currentUserId]);

    // A different conversation is a different marker, so the throttle starts over.
    useEffect(() => {
        lastMarkedMessageIdRef.current = null;
    }, [conversationId]);

    /*
        Held for the same reason the load is: nothing below can be decided without the
        reader's own uid, and rendering a guess is what the guard exists to prevent. The
        message is the same one the conversation load prints, so a reader watching this
        is not told anything the next moment would contradict.
    */
    if (loading || !authReady) {
        return <PageLoader label="Loading conversation…" />;
    }

    if (loadError || !conversation) {
        return (
            <div className="min-h-screen bg-canvas">
                <AppNavbar user={navUser} />

                <PageContainer className="py-8">
                    <div className="mx-auto max-w-2xl space-y-6">
                        <ActionLink to="/messages" variant="secondary">
                            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                            Back to messages
                        </ActionLink>
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{loadError || CONVERSATION_ERROR}</span>
                        </div>
                    </div>
                </PageContainer>
            </div>
        );
    }

    const isEmployer = currentUserId != null && conversation.employerId === currentUserId;
    const counterpartRole = isEmployer ? 'applicant' : 'employer';
    const sentAt = lastMessageLabel(conversation.lastMessageAt);

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <ActionLink to="/messages" variant="secondary" className="mb-6">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back to messages
                </ActionLink>

                {/*
                    The header. WHO is the heading and WHAT is the caption, and both say so
                    when they could not be resolved rather than collapsing into one label --
                    the Stage 8F rule, which exists because one missing value used to blank
                    the other.
                */}
                <PageHeader
                    title={counterpartName || (isEmployer ? 'Applicant' : 'Employer')}
                    description={contextLabel ? `Re: ${contextLabel}` : 'The related job is no longer available.'}
                    className="mb-4"
                />

                {!counterpartName && (
                    <p className="text-xs text-foreground-subtle">This participant has no name on their profile.</p>
                )}

                {sentAt && (
                    <p className="text-xs text-foreground-subtle">Last activity: {sentAt}</p>
                )}

                <Card className="mt-4 p-4 sm:p-6">
                    <ConversationThread
                        conversationId={conversation.id}
                        counterpartName={counterpartName}
                        counterpartRole={counterpartRole}
                        contextLabel={contextLabel}
                        onMessagesLoaded={markReadFor}
                    />
                </Card>
            </PageContainer>
        </div>
    );
};

export default ConversationPage;