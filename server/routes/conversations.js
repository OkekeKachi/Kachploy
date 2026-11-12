const express = require('express');
const router = express.Router();
const conversationController = require('../controllers/conversationController');
const {
    protect,
    requireConversationParticipant,
    requireConversationParty,
} = require('../middleware/auth');

// STAGE 8B: the chat resource, mounted at /conversations in app.js.
//
// Six endpoints, no business logic and no inline handlers -- route definitions and
// middleware only, like every router in this codebase.
//
// STAGE 10B added two of them: GET /:conversationId, which the dedicated thread screen
// needs to name the other participant and caption the job, and
// PUT /:conversationId/read, which is the ONLY route in the resource that writes read
// state. Both reuse requireConversationParty unchanged; neither introduces a new kind
// of caller.
//
// AUTHORIZATION: every route is party-scoped, and both decisions are made in the
// guards rather than in the controller:
//   requireConversationParticipant  POST /conversations
//                                  Either party to the application -- its applicant
//                                  or the employer who posted its job -- may open
//                                  that application's conversation. Body-based,
//                                  because the conversation may not exist yet, so
//                                  there is nothing conversation-scoped to authorize
//                                  and the participants have to be resolved the long
//                                  way through application -> job.
//   requireConversationParty        GET /:conversationId,
//                                  GET and POST /:conversationId/messages,
//                                  PUT  /:conversationId/read
//                                  Either participant named on the conversation
//                                  itself may read it, post to it, and mark it read
//                                  for their own side. One document read, no chain --
//                                  the conversation carries both uids. The second
//                                  guard in auth.js to admit two kinds of caller,
//                                  after requireInterviewParty.
//
// Neither participant has strictly more rights than the other: both may read the
// thread, both may post in it, and each may mark only their OWN side read -- the uid
// comes from the token, so there is no route on which one can mark the other's
// conversation read. A later stage that adds message edit or delete will need its own
// authorship guard, because these two answer membership rather than authorship.
//
// Ordering: `GET /` is a single empty segment, so it cannot be shadowed by the
// three-segment `/:conversationId/messages` or `/:conversationId/read` paths on
// either method. Those two paths differ only in their static second segment.
//
// No DELETE, and no PUT that edits a conversation. A conversation is never removed and
// its content is never changed; the one PUT here writes read state, not content --
// see the note at the foot of conversationRepository.js.
router.post('/', protect, requireConversationParticipant, conversationController.createOrGetConversation);
router.get('/', protect, conversationController.listConversationsForCaller);
router.get('/:conversationId', protect, requireConversationParty, conversationController.getConversation);
router.get('/:conversationId/messages', protect, requireConversationParty, conversationController.listMessages);
router.post('/:conversationId/messages', protect, requireConversationParty, conversationController.sendMessage);
router.put('/:conversationId/read', protect, requireConversationParty, conversationController.markConversationRead);

module.exports = router;