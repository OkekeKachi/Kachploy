// conversationController.js
//
// HTTP layer for the chat resource (new in Stage 8B). Express handlers, each
// doing only the three things every controller in this codebase does: take identity
// from the verified token, call exactly one conversationService function, and
// translate the outcome into a status code and body.
//
// Stage 8B had four of them; Stage 10B adds GET /:conversationId and
// PUT /:conversationId/read, so there are six. Every one is party-authorised, and the
// decisions are made by the two
// Stage 8B guards in the router, exactly as requireInterviewParty is for interviews.
// No handler here re-derives membership, and -- the one that matters for a chat --
// no handler reads a sender identity from the request body.
//
// WHAT THIS CONTROLLER DELIBERATELY DOES NOT DO
//   * It does not touch `applications`. Opening a conversation leaves the
//     application's status exactly as it was, and sending a message does not move an
//     application from pending to interviewed or anything else. A conversation is
//     available at every stage of an application's life, which is the whole point of
//     anchoring it on the application.
//   * It does not touch `employments`. A message is not a hire, and a hire is not a
//     message. Employment records are still created in exactly one place --
//     applicationService.updateApplicationStatus with `accepted` -- so no amount of
//     chatting can produce one, and nothing in this path imports employmentService.
//   * It does not touch `interviews`. Chat is not an interview and does not schedule
//     one; Stage 7C's recorded deferral of chat to a later stage is what this
//     resource answers, and it answers it by being a separate resource rather than
//     by growing a `chat` field onto an interview.

const conversationService = require('../services/conversationService');

/**
 * Maps a service failure onto the HTTP response.
 *
 * The same helper the other five controllers use. Validation failures are turned
 * into a 400 and deliberately skip the console.error, matching the existing
 * convention that a request the caller got wrong is not a server fault.
 *
 * `errorKey` is not needed: no endpoint in this resource fails with `{ error }`
 * instead of `{ message }`.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof conversationService.ConversationValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof conversationService.ConversationNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * POST /conversations
 *
 * Guarded by requireConversationParticipant, which has already resolved the
 * application and its job and confirmed the caller is either that application's
 * applicant or the owner of its job. So the 400 for a missing applicationId and the
 * 404 for a missing application or job all come from that guard before this handler
 * runs.
 *
 * Both parties may call this, and neither is preferred: an employer opening a thread
 * with an applicant and an applicant opening one with an employer reach the same
 * conversation, and the service returns whichever call created it. Responds 200 in
 * both cases rather than 201, matching every other create in this API, and says
 * which of the two happened via `created` so a client can tell "I started this" from
 * "this already existed" without comparing ids.
 *
 * Responds `{ message, conversationId, conversation, created }`.
 */
const createOrGetConversation = async (req, res) => {
    const { applicationId } = req.body;

    try {
        const { conversationId, conversation, created } =
            await conversationService.createOrGetConversation(applicationId);

        res.status(200).json({
            message: created
                ? 'Conversation created successfully'
                : 'Conversation already exists',
            conversationId,
            conversation,
            created,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating conversation:',
            message: 'Failed to create conversation',
        });
    }
};

/**
 * GET /conversations
 *
 * The caller's own inbox, and the only endpoint in this resource that needs no
 * guard beyond `protect`: there is no id in the path to check, and the service takes
 * the uid from the verified token alone. An empty inbox is
 * `{ conversations: [], totalUnread: 0 }`, not a 404 -- a user who has never been in a
 * conversation is not a missing resource.
 *
 * Responds `{ conversations, totalUnread }`, mirroring `{ tasks }`, `{ employments }`
 * and `{ interviews }` on the other list endpoints, plus the two Stage 10B unread
 * fields: each row carries `unreadCount` and `lastMessage` alongside its stored
 * document, and `totalUnread` is the sum, for the navbar badge.
 *
 * STAGE 10B: this call does not mark anything read. The badge polls it on a timer, so a
 * list endpoint that marked conversations read would silently clear an unread message
 * every time somebody looked at their navbar. Marking is PUT /:conversationId/read,
 * and only the dedicated thread screen calls it.
 */
const listConversationsForCaller = async (req, res) => {
    const uid = req.user.uid;

    try {
        const { conversations, totalUnread } = await conversationService.listConversationsForCaller(uid);

        res.status(200).json({ conversations, totalUnread });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching conversations:',
            message: 'Failed to fetch conversations',
        });
    }
};

/**
 * GET /conversations/:conversationId
 *
 * STAGE 10B. One conversation's own document, for the dedicated thread screen, which
 * has to render the other participant's name and the job caption and can get neither
 * from the message list.
 *
 * Guarded by requireConversationParty, so both participants reach it and everyone else
 * is refused with a 403 carrying no conversation data. A missing conversation is a 404
 * at the guard.
 *
 * Responds `{ conversation }`. It carries no `unreadCount`: this screen marks the
 * conversation read rather than counting what is left, and a count here would mean
 * paying the per-conversation message pass the inbox already pays for, on the page that
 * needs it least.
 */
const getConversation = async (req, res) => {
    const { conversationId } = req.params;

    try {
        const conversation = await conversationService.getConversation(conversationId);

        res.status(200).json({ conversation });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching conversation:',
            message: 'Failed to fetch conversation',
        });
    }
};

/**
 * GET /conversations/:conversationId/messages
 *
 * Guarded by requireConversationParty, so the applicant and the employer named on
 * the conversation both reach this handler and everyone else is refused with a 403
 * carrying no message data. A missing conversation is a 404 at the guard.
 *
 * Messages are returned oldest first. The ordering is done in the service rather
 * than left to the client because a thread that can render out of order is a broken
 * thread; see the sort note in conversationService.listMessages.
 *
 * Responds `{ messages }`. A conversation nobody has written in yet is an empty
 * list, not a 404 -- the same rule the tasks and interviews lists follow.
 */
const listMessages = async (req, res) => {
    const { conversationId } = req.params;

    try {
        const messages = await conversationService.listMessages(conversationId);

        res.status(200).json({ messages });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching messages:',
            message: 'Failed to fetch messages',
        });
    }
};

/**
 * POST /conversations/:conversationId/messages
 *
 * Guarded by the same requireConversationParty as the read, which is correct because
 * Stage 8B gives the two participants identical rights: both may post in their own
 * thread, so there is no one-directional rule to express here.
 *
 * `senderId` is `req.user.uid`, passed to the service and never read from the body,
 * so a participant cannot post a message that appears to have come from the other
 * one. A body `senderId` is ignored rather than rejected.
 *
 * Responds `{ message, messageId }`, mirroring POST /tasks and POST /interviews --
 * the created message body is not returned, and no endpoint in this API returns a
 * document it just wrote. The client that sent it already has the text it wrote.
 */
const sendMessage = async (req, res) => {
    const { conversationId } = req.params;
    const senderId = req.user.uid;

    try {
        const { messageId } = await conversationService.sendMessage(conversationId, req.body, senderId);

        res.status(200).json({ message: 'Message sent successfully', messageId });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error sending message:',
            message: 'Failed to send message',
        });
    }
};

/**
 * PUT /conversations/:conversationId/read (Stage 10B)
 *
 * Guarded by the same requireConversationParty as the message routes, which is the
 * correct guard rather than a convenient one: marking read is something each
 * participant may do for themselves, and the uid is taken from the verified token, so
 * there is no body field through which one could mark the other's conversation read.
 *
 * Responds `{ message: 'Conversation marked as read', conversationId }`. No
 * `unreadCount`, and no updated document: the count that matters to a client is the
 * caller's own total, which it re-reads from the inbox, and returning a count of zero
 * here would be a claim about messages that may arrive a millisecond later.
 *
 * Deliberately PUT with no body rather than POST. It sets one marker to a known value
 * and is idempotent, which is what PUT means; it is also the shape Stage 10A used for
 * `PUT /interviews/:interviewId/response`.
 */
const markConversationRead = async (req, res) => {
    const { conversationId } = req.params;
    const uid = req.user.uid;

    try {
        await conversationService.markConversationRead(conversationId, uid);

        res.status(200).json({ message: 'Conversation marked as read', conversationId });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error marking conversation as read:',
            message: 'Failed to mark conversation as read',
        });
    }
};

module.exports = {
    createOrGetConversation,
    listConversationsForCaller,
    getConversation,
    listMessages,
    sendMessage,
    markConversationRead,
};