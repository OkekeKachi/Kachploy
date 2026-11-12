import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import api from '../api';

/**
 * STAGE 10B: the navbar's message icon and unread badge, pointing at /messages.
 *
 * WHY A COMPONENT AND NOT A BADGE INSIDE AppNavbar.jsx
 *   The badge needs data. AppNavbar is presentation and navigation -- its only
 *   asynchronous act in the whole file is signing out -- and adding a fetch, a poll
 *   interval and their cleanup to it would put a second responsibility in the one file
 *   every authenticated page renders. As its own component it can be read on its own,
 *   tested on its own, and mounted once.
 *
 * WHAT IT READS, AND WHY THAT ENDPOINT
 *   GET /conversations, for `totalUnread`. The alternative -- a dedicated unread-count
 *   route -- would be a second endpoint returning one number the existing list already
 *   computes, and the list is what the reader lands on when they click this anyway.
 *
 * THE POLL INTERVAL, AND WHY IT IS NOT THE THREAD'S FIVE SECONDS
 *   ConversationThread re-reads an OPEN thread every 5000ms, and that cost is one query
 *   against one conversation. This badge's is not: GET /conversations counts unread
 *   messages, so the server issues one message query per conversation in the inbox (see
 *   the note on listConversationsForCaller). An employer with forty conversations pays
 *   forty message reads -- every tick, on every page, whether or not they ever open
 *   /messages.
 *
 *   So 15000ms, deliberately. It is the same order of "you will see it shortly" as the
 *   thread's poll without paying three times as often for a summary number, and the
 *   place where five-second freshness actually matters -- the open thread -- is still
 *   covered by the thread's own poll. A badge that is up to fifteen seconds stale is
 *   not a wrong badge; a badge that costs a page full of reads every five seconds is a
 *   real bill.
 *
 *   It also deliberately does NOT poll while the reader is on /messages, where the inbox
 *   page has just loaded the same number and the thread screen has already marked its
 *   conversation read. Stopping there would mean the count is exactly right for the one
 *   view where it is also visible on every row, but it would add a location coupling
 *   between two components for a saving nobody asked for, so it is not done.
 *
 * THE BADGE HIDES AT ZERO
 *   Not "renders a 0". The Stage 6I note in AppNavbar records that a hardcoded "3"
 *   was worse than showing nothing; a permanently visible badge reading 0 is the same
 *   lie told more politely, and it trains people to look past the one thing that matters
 *   there. So there is no badge element at all when the count is zero.
 *
 * READS NEVER MARK READ, which is what makes polling this safe at all:
 * PUT /conversations/:id/read is a separate route, called only by the thread screen. A
 * badge that polled a list endpoint which marked conversations read would clear unread
 * messages just by existing in the navbar.
 */

/**
 * How often the badge re-reads the inbox.
 *
 * See the note above. 15000ms, not the thread's 5000ms, because this is the expensive
 * endpoint in the resource and the thread is the one where latency is felt.
 */
const BADGE_POLL_INTERVAL_MS = 15000;

/**
 * The largest number the badge will print.
 *
 * A four-digit badge on a 40px icon does not fit, so it stops growing and says "99+"
 * instead. The exact number is still in the inbox rows, where there is room for it;
 * this is a summary that has to stay inside the navbar.
 */
const BADGE_MAX = 99;

const MessagesNavLink = () => {
    const [totalUnread, setTotalUnread] = useState(0);

    /*
        One read at a time, same rule as ConversationThread's readInFlightRef: an interval
        that can stack requests will eventually resolve two of them out of order and show
        an older count over a newer one. Checked and cleared synchronously so two ticks in
        the same tick cannot both pass the check.
    */
    const inFlightRef = useRef(false);

    const fetchUnread = useCallback(async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;

        try {
            const res = await api.get('/conversations');
            const total = res.data ? Number(res.data.totalUnread) : 0;

            setTotalUnread(Number.isFinite(total) && total > 0 ? total : 0);
        } catch (err) {
            /*
                Silent, and deliberately so. The badge is an ornament on a navigation bar:
                a failed refresh must not put an error on every page of the app, and there
                is nothing the reader can do about a dropped request other than wait for the
                next tick, which happens in at most BADGE_POLL_INTERVAL_MS. The count keeps
                its last value rather than resetting to 0, so a transient failure cannot
                read as "you are caught up".
            */
            console.error('Error fetching the unread message count:', err);
        } finally {
            inFlightRef.current = false;
        }
    }, []);

    useEffect(() => {
        // Immediate, so the badge is right on arrival rather than 15 seconds late, and
        // then on the interval. The first read and every later one are the same call.
        fetchUnread();

        const intervalId = setInterval(fetchUnread, BADGE_POLL_INTERVAL_MS);

        return () => clearInterval(intervalId);
    }, [fetchUnread]);

    const label = totalUnread > BADGE_MAX ? `${BADGE_MAX}+` : String(totalUnread);

    return (
        <div className="relative">
            {/*
                STAGE 11.16: presentation only. The link now uses the navbar's own
                token classes (the same surface-muted hover and foreground-muted idle
                state as the profile button beside it) plus an explicit
                focus-visible ring, and the icon is marked decorative since the link
                already carries its accessible name. The destination, aria-label and
                every read/poll above are unchanged.
            */}
            <Link
                to="/messages"
                aria-label={`Messages${totalUnread > 0 ? `, ${totalUnread} unread` : ''}`}
                className="flex items-center rounded-md p-1.5 text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
                <MessageSquare className="h-5 w-5" aria-hidden="true" />
            </Link>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
                {totalUnread > 0 ? `${totalUnread} unread messages` : 'No unread messages'}
            </span>

            {/* Hidden at zero -- see the note at the top of this file. STAGE 11.16:
                the inline BADGE style object is replaced by compact token classes
                (danger surface, inverse text); min-width + line-height keep it a
                small, non-layout-affecting pill at every viewport. */}
            {totalUnread > 0 && (
                <span
                    aria-hidden="true"
                    className="absolute -right-1 -top-0.5 min-w-[1.125rem] rounded-full bg-danger px-1 text-center text-[11px] font-semibold leading-[1.125rem] text-foreground-inverse"
                >
                    {label}
                </span>
            )}
        </div>
    );
};

export default MessagesNavLink;