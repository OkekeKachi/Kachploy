import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';
import api from '../api';
import Button from './ui/Button';

/**
 * STAGE 8C: one conversation thread, and the composer that posts into it.
 *
 * ONE COMPONENT, ONE PLACE (STAGE 10B)
 *   Rendered by ConversationPage.jsx, the dedicated /messages/:conversationId screen.
 *   In Stages 8C-10A it had three: an application card on MyApplications.jsx, an
 *   applicant card on ViewJobApplications.jsx, and the selected row on Conversations.jsx.
 *   Stage 10B gave the thread an address, and everything that can address a thread now
 *   addresses that one screen -- the navbar, an application card's Message button, and a
 *   row in the inbox all navigate to the same URL rather than mounting a copy of this.
 *
 *   The employer and applicant views are still the same component with the same props:
 *   the Stage 8B contract makes both participants interchangeable (both may read the
 *   thread, both may post, requireConversationParty admits either), so there is no
 *   employer/employee branch anywhere in this file. What differs between the two sides
 *   is only which uid is "me", and that is read from the auth session rather than passed
 *   in, so the host page does not have to know the signed-in uid to render it.
 *
 * WHY THE HOST PAGES PASS A CONVERSATION ID RATHER THAN AN APPLICATION ID
 *   The Stage 8B contract stores a conversation under its application id, so the two
 *   are the same string. POST /conversations is idempotent -- a second call returns
 *   `created: false` and the existing conversation -- which is what lets a host page
 *   offer a "Message" button with no separate "does a conversation exist" check and
 *   no disabled/loading state for a lookup that has no endpoint.
 *
 * REST ONLY, AND WHY POLLING RATHER THAN A LIVE FEED
 *   Every message list and every send goes through the axios instance in ../api, which
 *   is the only sanctioned call path in this client. There is no onSnapshot, no
 *   Firestore client SDK, no SSE and no socket: STAGE 8D adds a 5-second poll against
 *   the same GET /conversations/:id/messages endpoint, which is the only chat request
 *   this component has ever made.
 *
 *   Polling was chosen over a live feed rather than being the fallback for one. The
 *   decisive constraint is server-side: this project's Firestore security rules are
 *   not in the repository and their deployed state is unknown, so a client SDK
 *   subscription cannot be shown to be safe. A poll is authorized entirely by
 *   requireConversationParty on the server, exactly like every other read in this API,
 *   which makes it the transport that does not depend on an unverified assumption.
 *
 * WHY A SUCCESSFUL SEND RE-READS THE THREAD INSTEAD OF APPENDING LOCALLY
 *   POST /conversations/:id/messages answers `{ message, messageId }` and does NOT
 *   return the stored message, so an optimistic append would have to invent the
 *   server's `createdAt` from the browser clock and then guess at its position --
 *   and the ordering this component relies on is the server's, not the client's. One
 *   extra GET after a send is the honest way to keep the rendered order equal to the
 *   contract in GET /conversations/:id/messages. The alternative was rejected rather
 *   than overlooked; see the ordering note on the render below.
 *
 * STAGE 8F, AND WHO "THEY" IS
 *   The Stage 8B conversation document carries only `employerId` and `employeeId` --
 *   no names -- so this component cannot work out who it is talking to from the
 *   conversation alone. Rather than guess, the HOST PAGE resolves the name and passes
 *   it in: `counterpartName`, `counterpartRole` and `contextLabel`. See
 *   ConversationLauncher.jsx for where that resolution happens and why it costs
 *   nothing until a thread is actually opened.
 *
 *   Every one of those three is optional and every rendering below has a stated
 *   fallback. That is deliberate rather than defensive padding: a conversation
 *   deliberately outlives its application and its job (Stage 8E), so "the job is gone"
 *   and "this person has no profile name" are reachable states of this feature, not
 *   hypotheticals. An unresolved name falls back to the participant's ROLE -- "the
 *   employer", "the applicant" -- which is still true, still useful, and does not
 *   pretend a name was never available.
 */

// Mirrors the local helper of the same name in MyApplications.jsx and
// ViewJobApplications.jsx. Those files each keep their own copy and both document
// that there is deliberately no shared module, so this is a third local copy rather
// than a refactor of the other two -- which is out of this stage's scope.
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

/**
 * Decodes the shapes a stored timestamp can arrive in.
 *
 * Stage 8B writes `createdAt` with FieldValue.serverTimestamp(), so it arrives as
 * `{_seconds, _nanoseconds}` -- the same wire shape `dateLabel` in HiredJobs.jsx and
 * `scheduledLabel` in EmployeeInterviews.jsx already decode. A missing or malformed
 * value yields null rather than throwing, so one bad timestamp cannot take down a
 * whole thread.
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

const sentAtLabel = (value) => {
    const date = toDate(value);
    if (!date) return '';

    return date.toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
    });
};

/**
 * STAGE 8D: how often an OPEN thread re-reads itself.
 *
 * 5000ms is a product judgement, not a measurement. It is long enough that an open
 * thread is not holding a request open -- the read is a single GET against a
 * single-field Firestore query -- and short enough that a reply reads as a reply
 * rather than as a coincidence.
 *
 * This is per OPEN THREAD, and a thread is only mounted after a deliberate click (see
 * ConversationLauncher), so an employer with a long applicant list does not pay for
 * this at all until a thread is actually on screen. It is deliberately NOT applied to
 * the conversation LIST: that is fetched once per page visit, and polling it would
 * multiply the cost by the number of open threads for a list that changes far less
 * often than a thread does.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * STAGE 8F: the server's message length cap, restated on the client.
 *
 * Stage 8B puts this in conversationService as MESSAGE_MAX_LENGTH = 2000 and validates
 * every body against it. It is named here for the same reason the rest of this codebase
 * duplicates small values across the client/server line: the client cannot import a
 * server module, and a shared constants module for one number would be a larger change
 * than the value.
 *
 * STAGE 8C hardcoded `2000` into the input's maxLength; this stage replaces that literal
 * with this constant so the textarea's cap and the counter that reports it cannot drift
 * apart, and so the value has one place to be changed.
 *
 * The server remains the authority. This only stops the client from offering to send
 * something the server will refuse.
 */
const MAX_MESSAGE_LENGTH = 2000;

/*
    STAGE 11.14: the local style objects that used to live here (SECTION, HEADING, LINE,
    LIST, BUBBLE_BASE/MINE/THEIRS, META, FORM, INPUT, SEND_BUTTON, STALE_NOTE) are gone.
    Every one of them was a hardcoded colour, radius, spacing or size that the design
    system now owns, so the elements below carry Tailwind utilities that resolve to the
    shared tokens instead. The behaviours those objects existed to protect are kept:
    the bubble still caps at 85% and breaks long tokens (`max-w-[85%]` + `break-words`,
    which is `overflow-wrap: anywhere` on the value), the composer still sets `text-base`
    (16px) so mobile Safari does not zoom, and it still auto-grows to a cap. Only the one
    value that is genuinely local -- that cap -- is kept as a constant.
*/

/** How tall the auto-growing composer may get before it scrolls instead. */
const MAX_COMPOSER_HEIGHT_PX = 120;

/**
 * STAGE 8F: what to call the other participant when there is no name to show.
 *
 * The role is the honest fallback because it is the one fact about the other party that
 * is always available -- it is stored on the conversation itself, alongside the uid.
 * Naming the role rather than saying "Unknown" tells the reader something true and
 * useful; the sentence that accompanies it says plainly that a name was expected, so
 * the absence reads as missing data rather than as anonymity.
 */
const ROLE_PHRASE = {
    employer: 'the employer',
    applicant: 'the applicant',
};

const UNKNOWN_NAME_NOTE = 'Their name is not available from the profile.';

/**
 * @param conversationId  the Stage 8B conversation id (== its application id)
 * @param counterpartName optional resolved display name of the OTHER participant.
 *                        Null/absent is a supported state, not an error: see the
 *                        STAGE 8F note at the top of this file.
 * @param counterpartRole 'employer' | 'applicant' -- the reader's counterpart in this
 *                        conversation. Supplies the fallback wording when no name
 *                        resolves, so the thread is never labelled "Unknown".
 * @param contextLabel    optional related-job caption. Null/absent means the job is no
 *                        longer available, which the header states rather than hiding.
 * @param onSent          optional callback invoked after a successful send, so a host
 *                        page can refresh its own list or close the thread.
 * @param onMessagesLoaded STAGE 10B. optional callback invoked with the loaded message
 *                        array after EVERY successful read -- the first load and each
 *                        5-second poll alike. It exists for the read-state throttle in
 *                        ConversationPage.jsx, which has to know when a message from the
 *                        other participant is on screen so it can mark the thread read.
 *                        It reports the array and decides nothing: this component's
 *                        rendering is identical with or without it, so a host that does
 *                        not pass it behaves exactly as it did in Stage 8C.
 */
const ConversationThread = ({ conversationId, counterpartName, counterpartRole, contextLabel, onSent, onMessagesLoaded }) => {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    /*
        STAGE 8D: `pollError` is kept SEPARATE from `loadError` rather than folded into
        it, because the two must behave differently.

        `loadError` is the initial-load failure and it REPLACES the thread -- `messages`
        is empty when it is set, so showing both would contradict itself, which is the
        rule EmployeeInterviews already follows.

        `pollError` is a FAILED REFRESH of a thread that is already on screen. It must
        not replace anything: the reader still has every message they had a moment ago,
        and blanking the thread every time a background request hiccups would make the
        5-second poll feel far more destructive than it is. So it renders as a muted
        line underneath the messages, carries no role="alert" so a screen reader is not
        interrupted on every failed tick, and holds a fixed string -- so once it is set,
        further failed ticks set the identical value and React discards the re-render
        instead of flickering it.
    */
    const [pollError, setPollError] = useState(null);
    const [draft, setDraft] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [sendError, setSendError] = useState(null);
    const [currentUserId, setCurrentUserId] = useState(null);
    const composerId = `composer-${conversationId}`;
    const composerHelpId = `composer-help-${conversationId}`;
    const sendErrorId = `composer-error-${conversationId}`;

    /*
        STAGE 8F: the auto-growing composer. The height is set imperatively rather than
        from state because it has to be measured -- React cannot know scrollHeight -- and
        writing it on every keystroke would cost a render per character. The effect runs
        on `draft`, so it also runs when a send clears the field and shrinks the box back
        down on its own.
    */
    const textareaRef = useRef(null);

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;

        // Collapse to 0 first, or the height can only ever grow: scrollHeight of the
        // already-stretched textarea is the stretched height, not the content's.
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
    }, [draft]);

    /*
        STAGE 8F: what to call the other participant.

        A resolved name wins. Failing that, the role -- which is always stored on the
        conversation -- is used, so the thread never renders a bare "Unknown" that reads
        as a bug. `hasName` is kept separately from the derived phrase because the header
        has to distinguish "we have a name" from "we are showing you the role instead",
        and only the second is worth a sentence explaining itself.
    */
    const hasName = typeof counterpartName === 'string' && counterpartName.trim() !== '';
    const counterpartText = hasName
        ? counterpartName.trim()
        : (ROLE_PHRASE[counterpartRole] || 'the other party');

    /*
        STAGE 8C: `isSending` alone cannot stop a double submit. Two clicks dispatched
        in the same tick both read the pre-update render, because React has not
        rerendered yet, so both would reach POST /conversations/:id/messages and the
        other party would see the same message twice. This ref is checked and set
        synchronously, before the first await, so the second submit returns
        immediately. This is the same guard ViewJobApplications.jsx uses for its hire
        and clear-for-hiring buttons, for the same reason.
    */
    const sendingInFlightRef = useRef(false);

    /*
        STAGE 8D, OVERLAP PREVENTION. At most one read is in flight at a time.

        Without this, a slow response would let ticks stack up: each tick fires on its
        own schedule regardless of whether the previous one came back, so on a slow
        connection several GETs could be outstanding and resolve out of order. The last
        one to resolve would win, which is not the same as the newest one.

        Checked and set synchronously before the first await, for the same reason
        sendingInFlightRef is. It is reset in the polling effect's body rather than in
        its cleanup, so that changing conversation does not have to wait for the old
        request to finish before the new one can start -- see the generation note below.
    */
    const readInFlightRef = useRef(false);

    /*
        STAGE 8D, STALE-RESPONSE PREVENTION.

        A generation counter, bumped when `conversationId` changes. Every read captures
        the generation it was issued under and discards its response if the counter has
        moved on. This is what stops a slow reply for a conversation the reader has
        already closed from landing in the one they have just opened -- the failure that
        matters, because the two threads are different documents and the wrong one
        appearing under the right heading is indistinguishable from a real thread.

        Bumped in BOTH the effect body (to claim a generation for the new conversation)
        and its cleanup (to orphan any request still in flight for the old one), so a
        request is invalidated whether it is still running when the reader switches or
        has already resolved.
    */
    const generationRef = useRef(0);

    /*
        STAGE 10B. The latest `onMessagesLoaded`, held in a ref so that the read path
        below can call it without depending on it. The alternative -- listing it in
        loadMessages' dependencies -- would make this thread re-read itself and restart
        its poll every time the host passed a new callback, which ConversationPage does
        the moment the auth session resolves. A ref keeps the poll interval honest.
    */
    const onMessagesLoadedRef = useRef(onMessagesLoaded);

    useEffect(() => {
        onMessagesLoadedRef.current = onMessagesLoaded;
    }, [onMessagesLoaded]);

    // One listener, and only while a thread is actually open: this component is not
    // mounted for a conversation nobody has opened, so an employer with a long
    // applicant list does not accumulate a listener per card.
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setCurrentUserId(user ? user.uid : null);
        });

        return () => unsubscribe();
    }, []);

    /*
        STAGE 8D: ONE loader, TWO modes.

        `background` is what separates "this thread is being opened" from "this thread
        is already on screen and a tick just landed":

          background: false -- the initial load, and the refresh after a successful
              send. Owns the full-page loading state and the hard error, because there
              is nothing on screen yet that could be preserved.

          background: true -- a 5-second poll. Leaves `loading` untouched so the
              messages stay rendered for the whole refresh, and leaves `messages`
              untouched on failure so a dropped request cannot empty a visible thread.

        `generation` is passed IN rather than read off the ref inside, so the value a
        request was issued under is captured once at call time. Reading
        generationRef.current before the await would behave identically for a lone poll
        and break silently the moment a poll overlapped a conversation switch, which is
        exactly the case the counter exists to catch.
    */
    const loadMessages = useCallback(async ({ generation, background }) => {
        // At most one read outstanding -- see the note on readInFlightRef.
        if (readInFlightRef.current) return;
        readInFlightRef.current = true;

        if (!background) {
            setLoading(true);
            setLoadError(null);
        }

        try {
            const res = await api.get(`/conversations/${conversationId}/messages`);

            // Orphaned by a conversation switch or an unmount -- see generationRef.
            if (generation !== generationRef.current) return;

            /*
                REPLACE, NEVER APPEND. This response IS the thread: membership and order
                are both the server's, already sorted oldest-first by
                conversationService.listMessages. So it overwrites `messages` outright.

                Nothing is merged and nothing is de-duplicated by hand precisely because
                nothing needs to be. A merge -- appending, or filtering by id -- is what
                would INTRODUCE a duplicate, since it would be reconciling against a list
                the server has just restated in full.
            */
            const loaded = Array.isArray(res.data.messages) ? res.data.messages : [];

            setMessages(loaded);

            if (background) setPollError(null);

            /*
                STAGE 10B. Reported through the ref above rather than called directly, so
                that `loadMessages` does not depend on the host's callback identity: a
                host whose callback changes (ConversationPage's does, the moment the auth
                session resolves) would otherwise restart this thread's poll interval and
                cost an extra read.

                Called only on a successful read, never on a failed one. `messages` holds
                whatever was last received after a failure, and a host could not tell that
                apart from what was just received -- so it is only ever told about messages
                that are actually on screen. The same `loaded` array is handed over that
                was handed to state, rather than a second read of the response, so the
                host cannot be told about something other than what is rendered.
            */
            const reportTo = onMessagesLoadedRef.current;
            if (reportTo) reportTo(loaded);
        } catch (err) {
            if (generation !== generationRef.current) return;

            console.error(`Error fetching messages for conversation ${conversationId}:`, err);

            if (background) {
                // Keep the thread exactly as it is; note the staleness quietly.
                setPollError(readErrorMessage(err, 'Could not refresh -- showing the last messages received.'));
            } else {
                setMessages([]);
                setLoadError(readErrorMessage(err, 'Messages could not be loaded.'));
            }
        } finally {
            /*
                Only the CURRENT generation may clear these. A stale request resolving
                late must not switch off the loading state belonging to the thread now on
                screen, and must not release the in-flight guard that a newer request is
                holding.
            */
            if (generation === generationRef.current) {
                readInFlightRef.current = false;
                // Background polls never touch `loading`; only the initial load ends.
                if (!background) setLoading(false);
            }
        }
    }, [conversationId]);

    /*
        STAGE 8D: the poll itself. Immediate first read, then POLL_INTERVAL_MS.

        `loadMessages` changes identity only when `conversationId` does, so this effect
        runs exactly once per open thread and re-runs exactly when the reader switches
        conversation. Both the interval and the orphaned in-flight request are then
        handled by the cleanup, which is what satisfies "clean up when the thread
        unmounts or the conversation ID changes" in a single place.
    */
    useEffect(() => {
        // Claim a generation for this conversation -- see generationRef.
        generationRef.current += 1;
        const generation = generationRef.current;

        // Release the in-flight guard so this thread is not blocked behind the request
        // for the conversation just left. Correct to do eagerly, because `generation`
        // -- not this guard -- is what now separates the two requests.
        readInFlightRef.current = false;

        // Immediate, so the thread is populated on open rather than 5 seconds later.
        loadMessages({ generation, background: false });

        const intervalId = setInterval(() => {
            loadMessages({ generation, background: true });
        }, POLL_INTERVAL_MS);

        return () => {
            clearInterval(intervalId);

            // Runs on unmount AND on a conversationId change, and orphans any request
            // still in flight for the generation being torn down.
            generationRef.current += 1;
        };
    }, [loadMessages]);

    const handleSend = async (event) => {
        event.preventDefault();

        // Synchronous guard, before any await -- see the note on sendingInFlightRef.
        if (sendingInFlightRef.current) return;

        const body = draft.trim();

        // Do not spend a request on input the server will refuse with the same 400.
        // The server still validates this; this is an affordance, not the rule.
        if (body === '') {
            setSendError('Type a message before sending.');
            return;
        }

        sendingInFlightRef.current = true;
        setIsSending(true);
        setSendError(null);

        try {
            /*
                STAGE 9H. `{ body }` is the whole payload, sent flat.

                This used to read `{ body: { body } }`, written as though the second
                argument to an axios POST were a config object. It is not: for
                post/put/patch the second positional argument IS the payload, so the
                nested `body` key was serialized literally and the server received
                `{ "body": { "body": "..." } }`. conversationService reads
                `payload.body`, found the nested object instead of the string, and
                refused it with the same 400 this component's own empty-draft check
                above is written to avoid -- reported as a server error on a request
                that was in fact well formed.

                The server contract is unchanged and still wants a top-level `body`.
                Do not reintroduce the wrapper: a config object is the THIRD argument
                here, and this call does not need one.
            */
            await api.post(`/conversations/${conversationId}/messages`, { body });

            /*
                STAGE 8C: the input is cleared ONLY on success. Clearing it in a
                `finally` would discard what the user typed whenever the request
                failed, which is the one thing they would want to retry. The re-read
                then repopulates the thread from the server, which is the ordering
                authority -- see the note at the top of this file.
            */
            setDraft('');

            /*
                STAGE 8D: the re-read is a BACKGROUND refresh. Passing `false` here would
                raise the full-page loading state, which would blank a thread the reader
                has been looking at and make their own message vanish and reappear a
                moment later. What is already on screen is correct; this call only
                reconciles it with the server's ordering.

                `generationRef.current` rather than a captured generation, because the send
                may well have completed AFTER the reader switched conversations -- in
                which case refreshing the newest generation is the right thing, and the
                reload lands in whichever thread is now open instead of one they left.

                If a poll happens to be in flight at this moment the read is skipped by
                the overlap guard, and the message the server has already stored appears
                on the next tick instead -- at most POLL_INTERVAL_MS later.
            */
            await loadMessages({ generation: generationRef.current, background: true });

            if (onSent) onSent();
        } catch (err) {
            console.error('Error sending message:', err);
            setSendError(readErrorMessage(err, 'Your message could not be sent.'));
        } finally {
            // Cleared in `finally` so neither a failed send nor a failed re-read can
            // leave the composer stuck in a sending state.
            sendingInFlightRef.current = false;
            setIsSending(false);
        }
    };

    /*
        STAGE 8F: Enter sends, Shift+Enter inserts a newline.

        This is why the composer is a textarea rather than the single-line input it used
        to be, and the trade is worth stating plainly because it cuts both ways:

          * A single-line input made Enter-to-send trivial -- and made writing a two-line
            message impossible without a second control. A chat where the natural
            gesture cannot express the message is not a chat.
          * A textarea with a plain Enter that inserts a newline is the opposite
            annoyance: you cannot send at all without finding the button, which on a
            phone means aiming at a target while holding a keyboard.

        Enter-to-send plus Shift+Enter-for-newline is the convention every mainstream
        chat uses, so it is what this follows, and the Send button stays because on a
        touch keyboard the button is the reliable path and the keyboard hint is not
        guaranteed.

        IME composition is checked first and the event is left alone when it is
        mid-composition. This is not a hypothetical: for Japanese, Chinese and Korean
        input, Enter is the key that CONFIRMS a candidate -- the composed character is
        committed by that keypress. Swallowing it would make those scripts unusable in
        this composer, so `isComposing` (with the legacy 229 keyCode as a fallback for
        older engines) has to be checked before the send decision is made at all.
    */
    const handleKeyDown = (event) => {
        if (event.key !== 'Enter') return;

        // Shift+Enter is the newline gesture. Checked before the send path so a
        // multi-line draft is possible at all.
        if (event.shiftKey) return;

        const native = event.nativeEvent;
        if (native && (native.isComposing || native.keyCode === 229)) return;

        // Handled here rather than left to the implicit form submission, because
        // preventDefault stops the textarea inserting the newline before the send is
        // attempted -- otherwise every send would leave a leading blank line behind.
        event.preventDefault();
        handleSend(event);
    };

    return (
        <div className="space-y-3">
            <h5 className="text-base font-semibold text-foreground">Conversation</h5>

            {/*
                STAGE 8F. The identity block. The name is the headline when there is one;
                when there is not, the role is shown instead and the absence is stated in
                one muted line, so the reader is never left wondering whether "the
                applicant" is a name, a placeholder, or a bug.

                The related job is a separate line from the name on purpose: a job is the
                WHAT and a person is the WHO, they change independently (Stage 8E keeps a
                thread alive after either is deleted), and collapsing them into one
                string meant one missing value silently blanked the other.
            */}
            <p className="text-sm text-foreground">
                <strong>With:</strong> {counterpartText}
            </p>
            {!hasName && <p className="text-xs text-foreground-subtle">{UNKNOWN_NAME_NOTE}</p>}

            {contextLabel ? (
                <p className="text-sm text-foreground">
                    <strong>About:</strong> {contextLabel}
                </p>
            ) : (
                /*
                    The "unavailable conversation context" state. Reached whenever the
                    related job has been deleted or otherwise cannot be read -- a real
                    state from Stage 8E, where a conversation deliberately outlives its
                    job. Stating it keeps the header honest and stops the thread looking
                    broken; the conversation itself remains fully usable below.
                */
                <p className="text-xs text-foreground-subtle">
                    The related job is no longer available.
                </p>
            )}

            {loading && <p role="status" className="text-sm text-foreground-muted">Loading messages...</p>}

            {/*
                An error replaces the thread rather than sitting above it: `messages` is
                empty on failure, so rendering both would show an empty thread beside a
                load failure and contradict itself. Same rule as EmployeeInterviews.
            */}
            {!loading && loadError && (
                <p role="alert" className="text-sm text-danger">{loadError}</p>
            )}

            {!loading && !loadError && (
                messages.length === 0 ? (
                    /*
                        STAGE 8F. Names who the message is for, so an empty thread on a
                        page with several of them is not ambiguous. It also points at the
                        composer, which is the only action available.
                    */
                    <p className="text-sm text-foreground-muted">
                        No messages yet. Write the first message to {counterpartText} below.
                    </p>
                ) : (
                    <ul className="flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0">
                        {/*
                            OLDEST FIRST, BY NOT REVERSING.
                            GET /conversations/:id/messages returns the thread already
                            ordered oldest-first -- conversationService.listMessages sorts
                            before the response is built -- so rendering `messages` in
                            array order is what puts the oldest message at the top. A
                            `.reverse()` or a `.slice().sort()` here would be the bug, not
                            the fix, and would break the moment the server's ordering
                            contract changed.
                        */}
                        {messages.map((message) => {
                            // Falls back to the "them" style if the uid has not resolved
                            // yet or the message predates this account, rather than
                            // dropping the message or mislabelling it as the reader's.
                            const isMine = currentUserId != null && message.senderId === currentUserId;
                            const sentAt = sentAtLabel(message.createdAt);

                            return (
                                <li
                                    key={message.id}
                                    // The distinction is also carried in text, not only in
                                    // alignment and colour: "You" is what a screen reader
                                    // announces, and colour alone would leave the thread
                                    // unreadable to anyone who cannot distinguish the two
                                    // shades.
                                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 ${
                                        isMine
                                            ? 'self-end bg-accent text-foreground-inverse'
                                            : 'self-start bg-surface-muted text-foreground'
                                    }`}
                                    aria-label={isMine ? 'Message you sent' : 'Message from the other party'}
                                >
                                    <p className={`mb-0.5 text-xs ${isMine ? 'text-foreground-inverse/80' : 'text-foreground-subtle'}`}>
                                        {/*
                                            STAGE 8F: the same resolved `counterpartText`
                                            the header uses, so an incoming message is
                                            attributed to the same name the reader was
                                            introduced with. Falling back to the role
                                            keeps attribution working when no name
                                            resolved.
                                        */}
                                        <strong>{isMine ? 'You' : counterpartText}</strong>
                                        {sentAt && ` · ${sentAt}`}
                                    </p>
                                    <p className="m-0 whitespace-pre-wrap break-words">
                                        {message.body}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )
            )}

            {/*
                STAGE 8D. Renders BELOW the messages, never in place of them, and carries
                no role="alert": a failed refresh is a background condition, and
                announcing it every few seconds would interrupt the reader far more than
                the staleness it reports. It clears itself on the next successful poll,
                so the note cannot outlive the problem.
            */}
            {pollError && <p className="text-xs text-foreground-subtle">{pollError}</p>}

            <form className="flex flex-wrap items-end gap-2 pt-1" onSubmit={handleSend}>
                {/*
                    STAGE 8F. The hint is not decoration: `enterKeyHint="send"` is the
                    attribute that makes a touch keyboard render a Send-labelled return key
                    instead of a newline key, which is what makes Enter-to-send usable on a
                    phone at all. It pairs with handleKeyDown, which does the work.

                    `rows={1}` with an auto-growing height gives a single-line composer that
                    expands as needed, rather than a fixed box that is either too small for a
                    long message or too tall for a short one.
                */}
                <label htmlFor={composerId} className="text-xs text-foreground-subtle">
                    Message
                </label>
                <textarea
                    ref={textareaRef}
                    id={composerId}
                    aria-invalid={sendError ? 'true' : undefined}
                    aria-describedby={sendError ? sendErrorId : composerHelpId}
                    className="min-w-0 flex-1 basis-44 resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-base leading-relaxed text-foreground placeholder:text-foreground-subtle transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:bg-surface-muted"
                    value={draft}
                    rows={1}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    enterKeyHint="send"
                    disabled={isSending}
                    maxLength={MAX_MESSAGE_LENGTH}
                />
                <Button
                    type="submit"
                    size="lg"
                    /*
                        STAGE 8F, and rule 6. The button is disabled on a whitespace-only
                        draft, not merely an empty one: `trim()` is what decides, so a field
                        holding a newline and some spaces cannot be sent by pressing Send
                        and then bounced by the server as a 400. handleSend re-checks the
                        same condition, because Enter bypasses this button entirely.
                    */
                    disabled={isSending || draft.trim() === ''}
                >
                    {isSending ? 'Sending...' : 'Send'}
                </Button>
            </form>

            {/*
                STAGE 8F: the character counter. The server caps a body at 2000
                characters (Stage 8B's MESSAGE_MAX_LENGTH), and the textarea's maxLength
                stops a paste from being truncated silently -- so a long paste is visibly
                cut rather than mysteriously missing its tail. The count is shown only as
                the draft approaches the cap, so an empty composer stays quiet.
            */}
            {draft.trim().length > MAX_MESSAGE_LENGTH - 200 && (
                <p className="text-xs text-foreground-subtle">
                    {draft.length} / {MAX_MESSAGE_LENGTH} characters
                </p>
            )}

            {sendError && <p id={sendErrorId} role="alert" className="text-sm text-danger">{sendError}</p>}

            {/*
                STAGE 8D. Stated on screen rather than left implicit: since 8C this thread
                has re-read itself only on open and after a send, and the reader was told
                so in as many words. It now re-reads every 5 seconds, so a reply from the
                other party appears on its own while the thread stays open.

                The interval is a target, not a guarantee -- a delayed or failed tick is
                reported in place rather than by interrupting -- so the reader knows a
                pause of a few seconds is expected and does not read the gap as a lost
                message.
            */}
            <p id={composerHelpId} className="text-xs text-foreground-subtle">
                This thread refreshes every 5 seconds, so replies appear on their own.
                Press Enter to send, Shift + Enter for a new line.
            </p>
        </div>
    );
};

export default ConversationThread;