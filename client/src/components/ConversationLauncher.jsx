import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Button from './ui/Button';

/**
 * STAGE 10B: the "Message" control on an application card.
 *
 * IT NAVIGATES NOW. It used to open a collapsed button that grew a full
 * ConversationThread underneath the card. The thread has its own screen
 * (/messages/:conversationId), and the two reasons that screen exists are the two reasons
 * this can no longer hold a thread of its own:
 *
 *   * An unread count needs a separate "opened" moment. Embedded, selecting the button
 *     WAS opening the thread, so there was nothing left for the reader to open later --
 *     and no address at which "this conversation" could be marked read after they had.
 *   * One thread, one URL. With a copy inside every application card, an employer
 *     reviewing forty applicants had forty possible threads and no way to link to,
 *     bookmark or go back to any of them. Now every "Message" on every page arrives at
 *     the same screen.
 *
 * So this component keeps exactly two jobs: make sure the conversation exists, and go
 * there. It is still the only place in the app that calls POST /conversations, which is
 * what makes the navigation total -- a card can offer "Message" for an application that
 * has never been messaged about, and the destination resolves.
 *
 * WHY THIS IS A SHARED COMPONENT RATHER THAN CODE IN BOTH HOST PAGES
 *   It is mounted from MyApplications.jsx (the applicant) and from
 *   ViewJobApplications.jsx (the employer), and the two need identical behaviour: an
 *   idempotent open, a navigation, and the same failure rendering. The only thing that
 *   differs between them is the wording on the button, which is what `counterpartRole` is
 *   for. Duplicating the open-and-navigate logic into both pages would have produced two
 *   copies to keep in step -- the arrangement MyApplications.jsx already documents
 *   avoiding when it notes there is "deliberately no shared status module" for the
 *   genuinely divergent label maps. This case is the opposite: the logic is the same, so
 *   it is shared once.
 *
 * WHY THE OPEN IS SAFE TO REPEAT
 *   POST /conversations is idempotent by contract -- Stage 8B stores the conversation
 *   under its application id, so a second call returns the same id with
 *   `created: false`. There is therefore no "does a conversation already exist" question
 *   to answer first, no lookup endpoint to call, and no state in which the button must be
 *   disabled while checking. Pressing "Message" twice issues two cheap calls and lands
 *   on the same screen, which is also what makes the button correct after a failure: the
 *   retry re-issues the open rather than navigating to a conversation that was never
 *   created.
 *
 * REST ONLY: the POST is a normal axios call through the shared instance in ../api,
 *   exactly like every other write in this client. Navigation afterwards is React
 *   Router's, not a `window.location` assignment, so the app is not torn down and
 *   refetched -- the same change Stage 6P made to this navbar's own links.
 *
 * STAGE 10B, AND WHERE THE COUNTERPART'S NAME WENT
 *   Until this stage this component resolved the other participant's display name,
 *   because it was about to render a thread that had to be headed with it. The thread now
 *   lives on its own screen, which resolves the name itself from GET /users/getUser/:id
 *   -- the same endpoint, and the same reasoning about it (userService.getUser returns a
 *   public profile for anyone else, so it is readable by both roles and survives a
 *   withdrawn application). ViewJobApplications already had `application.fullName` on
 *   every card and passed it here; that is now unused, because a name resolved before
 *   navigating is a name that is lost on a refresh, on a shared link and on a back
 *   navigation. The destination screen is the only place that can keep it correct.
 *
 *   That is also why the props below shrank to two. `counterpartUid`, `counterpartName`
 *   and `contextLabel` were all in service of a thread this component no longer renders,
 *   and passing data to a screen that has to work without it is how the two get out of
 *   step.
 */

// Same local helper as the other pages/components that use it; see the note on the
// shared-module convention in MyApplications.jsx.
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

const OPEN_ERROR = 'This conversation could not be opened. Please try again.';

/*
    `employer` and `applicant` are the READER's side, so the wording is about the person
    being messaged. The Stage 8B endpoint is the same for both and admits either
    participant, so nothing else about the request changes between them.
*/
const BUTTON_LABEL = {
    employer: 'Message applicant',
    applicant: 'Message employer',
};

/*
    THE PROP CONTRACT, which is now two fields:

      applicationId   the application whose conversation this opens.
      counterpartRole 'employer' | 'applicant' -- the READER's side, which is what the
                      button wording is about and the only other thing this component
                      needs.

    Stage 10B removed `counterpartUid`, `counterpartName` and `contextLabel`. They all
    existed to head a thread rendered here; see the note above on why the destination
    screen resolves them instead.
*/
const ConversationLauncher = ({ applicationId, counterpartRole = 'applicant' }) => {
    const [isOpening, setIsOpening] = useState(false);
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleOpen = async () => {
        setIsOpening(true);
        setError('');

        try {
            /*
                STAGE 9H. `{ applicationId }` is the whole payload, sent flat.

                This used to read `{ body: { applicationId } }`, written as though the
                second argument to an axios POST were a config object. It is not: for
                post/put/patch the second positional argument IS the payload, so the
                nested `body` key was serialized literally and the request went out as
                `{ "body": { "applicationId": "..." } }`.
                requireConversationParticipant destructures `applicationId` from the
                top level of req.body, found nothing there, and refused the request with
                400 "Missing required fields" -- so "Message" never opened a thread and
                every conversation feature behind it was unreachable.

                The same shape was used in the server test harness, where the second
                argument genuinely is an options bag with a `body` key. That is what made
                it look correct here.

                The server contract is unchanged and still wants a top-level
                `applicationId`. Do not reintroduce the wrapper: a config object is the
                THIRD argument here, and this call does not need one.
            */
            const res = await api.post('/conversations', { applicationId });

            /*
                STAGE 8C: the id comes from the response body, not from `applicationId`
                assembled here. They are equal by the Stage 8B storage contract, but the
                response is the authority for it -- so if that contract ever changed, this
                component would follow the server instead of quietly addressing the wrong
                document. `created` is deliberately not surfaced as a message: whether
                this click or an earlier one started the thread is not something the
                applicant needs told.
            */
            const id = res.data.conversationId || applicationId;

            navigate(`/messages/${id}`);
        } catch (err) {
            // Nothing is navigated to, and the card is left exactly as it was: a failed
            // open is reported here rather than by arriving on an empty thread screen.
            console.error('Error opening conversation:', err);
            setError(readErrorMessage(err, OPEN_ERROR));
        } finally {
            setIsOpening(false);
        }
    };

    return (
        <div>
            {/*
                STAGE 11.16: presentation only. The raw <button> is replaced by the
                shared Button primitive -- `secondary` because this is a supporting
                action wherever it is mounted -- and the error line uses the danger
                token instead of an inline colour. The type, the `disabled` guard on
                isOpening (the repeated-submission guard) and every prop/label above
                are unchanged.
            */}
            <Button
                type="button"
                variant="secondary"
                onClick={handleOpen}
                disabled={isOpening}
            >
                {isOpening ? 'Opening...' : BUTTON_LABEL[counterpartRole]}
            </Button>

            {error && (
                <p role="alert" className="mt-1.5 text-sm text-danger">{error}</p>
            )}
        </div>
    );
};

export default ConversationLauncher;