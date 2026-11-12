import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CreditCard, RefreshCw, Loader2 } from 'lucide-react';
import Card from './ui/Card';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import ReleasePanel from './ReleasePanel';
import {
    fetchContractForEmployment,
    fetchPaymentForMilestone,
    fetchPaymentForContract,
    createPaymentRecord,
    createContractPaymentRecord,
    initializePayment,
    initializeContractPayment,
    verifyPayment,
    verifyContractPayment,
} from '../api';
import {
    canInitiatePayment,
    canRefreshStatus,
    formatKoboAsNaira,
    isFullContract,
    isTrustedCheckoutUrl,
    makeContractPaymentIdempotencyKey,
    paymentErrorMessage,
    paymentStatusBadgeVariant,
    paymentStatusExplanation,
    paymentStatusLabel,
} from './paymentPresentation';
import { isActiveContract, isPendingAcceptance } from './contractPresentation';

/**
 * The payment section for ONE employment.
 *
 * WHAT THIS IS. It loads this employment's contract (from
 * GET /contracts/employment/:id) and shows its server-reported payment state.
 * A milestone contract lists every milestone and its payment; a full contract
 * shows the one agreement-total payment instead. Only the employer is offered
 * Checkout and Refresh status. It is rendered inside EmployeeWorkspace, which
 * already knows the employment and the signed-in user.
 *
 * THE SERVER OWNS EVERYTHING THAT MATTERS. Amounts, fees, the charge, the
 * reference, the checkout URL and the payment status all come from the server and
 * are rendered as returned. This component computes no financial figure, decides
 * no status, and never treats a redirect, a URL parameter or its own state as
 * proof that a payment succeeded. `payment.status` is the only truth it shows.
 *
 * ELIGIBILITY IS UI-ONLY. canInitiatePayment / canRefreshStatus decide which
 * controls to OFFER; they are not a security boundary. The backend re-derives the
 * employer from the verified token on every request (requireMilestoneEmployer
 * or requireContractPaymentEmployer), so an employee who somehow saw a Checkout
 * button would still be refused.
 *
 * THE INITIALIZE SEQUENCE, AND WHY IT IS SHAPED THIS WAY.
 *   1. If no payment record exists, POST /payments creates one. The idempotency
 *      key is generated ONCE per creation attempt and held in a ref, so a second
 *      click or a retry reuses it and the server treats the repeat as a replay --
 *      it never mints a fresh key for a repeated click.
 *   2. Only a `created` record, or a confirmed `failed` attempt, is initialized.
 *      A failed retry always uses a NEW server-minted Paystack reference, never
 *      the historical one. `pending`, `paid` and `needs_review` are never
 *      initialized (the server refuses those too; the pending latch makes an
 *      ambiguous in-flight attempt detectable).
 *   3. The returned checkoutUrl is re-validated here (HTTPS, hostname EXACTLY
 *      checkout.paystack.com) before a full-page navigation. A payload that fails
 *      this check is treated as an error, never navigated to.
 *   4. On ANY ambiguous failure (timeout, network, 5xx, malformed body) the record
 *      is left as the server left it and NO automatic retry is attempted. The
 *      employer is told the outcome is unconfirmed and to refresh the status.
 *
 * There is NO callback URL in this system (the backend deliberately sends none),
 * so checkout returns the employer to the browser, not to a special page. Refresh
 * status -- a deliberate, user-initiated POST /payments/verify -- is how the
 * outcome is confirmed afterward. There is no polling and no auto-verify.
 */

// A short, human-readable idempotency key. crypto.randomUUID is available in all
// browsers this app targets and in the Node test runner; the fallback keeps the
// panel working in an unusual environment rather than throwing.
const uniqueToken = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const makeIdempotencyKey = (milestoneId) =>
    `kp-${milestoneId}-${uniqueToken()}`.slice(0, 128);

const makeContractIdempotencyKey = (contractId) =>
    makeContractPaymentIdempotencyKey(contractId, uniqueToken());

const MilestonePaymentPanel = ({
    employment,
    currentUid,
    reloadToken = 0,
    onPaymentRefreshed,
}) => {
    const employmentId = employment && employment.id;

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [contract, setContract] = useState(null);
    // The milestone schedule from the contract endpoint's SIBLING `milestones`
    // array (it is not a field of the contract document).
    const [schedule, setSchedule] = useState([]);
    // milestoneId -> { payment | null }, plus a per-milestone read state.
    const [payments, setPayments] = useState({});
    const [readErrors, setReadErrors] = useState({});

    // The single payment record for a full contract, plus its read/action state.
    const [contractPayment, setContractPayment] = useState(null);
    const [contractReadError, setContractReadError] = useState('');
    const [contractBusy, setContractBusy] = useState(undefined);
    const [contractNotice, setContractNotice] = useState('');
    const [releaseReloadToken, setReleaseReloadToken] = useState(0);
    const contractBusyRef = useRef(false);
    const contractIdempotencyKey = useRef('');

    // Per-milestone in-flight action: 'checkout' | 'refresh' | undefined. One at a
    // time per milestone, which is what disables the buttons against double-clicks.
    const [busy, setBusy] = useState({});
    // Per-milestone one-line status message from the last action (success or safe error).
    const [notice, setNotice] = useState({});

    // The idempotency key for a milestone's CURRENT creation attempt. Held in a ref
    // so a retry of the same attempt reuses it; cleared only on a fresh attempt
    // that we deliberately start after a clean read.
    const idempotencyKeys = useRef({});
    // Mirror of `busy` readable synchronously inside handlers, so two rapid clicks
    // cannot both pass an async state check.
    const busyRef = useRef({});

    const isEmployer = Boolean(
        contract && currentUid && contract.employerId === currentUid
    );

    const setMilestoneBusy = useCallback((milestoneId, value) => {
        busyRef.current = { ...busyRef.current, [milestoneId]: value };
        setBusy(busyRef.current);
    }, []);

    const setMilestoneNotice = useCallback((milestoneId, message) => {
        setNotice((current) => ({ ...current, [milestoneId]: message }));
    }, []);

    // Re-reads one milestone's payment record. A 404 is the normal "no record yet"
    // state (fetchPaymentForMilestone maps it to { payment: null }); any other
    // failure is recorded per-milestone without taking the panel down.
    const reloadPayment = useCallback(async (milestoneId) => {
        try {
            const { payment } = await fetchPaymentForMilestone(milestoneId);
            setPayments((current) => ({ ...current, [milestoneId]: payment }));
            setReadErrors((current) => ({ ...current, [milestoneId]: '' }));
        } catch (err) {
            const message = paymentErrorMessage(err);
            setReadErrors((current) => ({ ...current, [milestoneId]: message }));
        }
    }, []);

    const reloadContractPayment = useCallback(async (contractId) => {
        try {
            const { payment } = await fetchPaymentForContract(contractId);
            setContractPayment(payment);
            setContractReadError('');
        } catch (err) {
            setContractReadError(paymentErrorMessage(err));
        }
    }, []);

    // Initial load: contract + milestones, then the applicable payment record(s).
    // A full contract has exactly one payment and no milestones; a milestone
    // contract has one payment per milestone.
    useEffect(() => {
        let cancelled = false;

        if (!employmentId) {
            setLoading(false);
            return () => {
                cancelled = true;
            };
        }

        setLoading(true);
        setLoadError('');

        (async () => {
            try {
                const { contract: loadedContract, milestones } =
                    await fetchContractForEmployment(employmentId);
                if (cancelled) return;

                setContract(loadedContract);
                setContractPayment(null);
                setContractReadError('');
                setContractNotice('');
                setContractBusy(undefined);
                contractBusyRef.current = false;
                contractIdempotencyKey.current = '';

                if (isFullContract(loadedContract)) {
                    setSchedule([]);
                    setPayments({});
                    setReadErrors({});
                    const { payment } = await fetchPaymentForContract(loadedContract.id);
                    if (cancelled) return;
                    setContractPayment(payment);
                    setLoading(false);
                    return;
                }

                const milestoneList = Array.isArray(milestones) ? milestones : [];
                setSchedule(milestoneList);
                setPayments({});
                setReadErrors({});

                const entries = await Promise.all(
                    milestoneList.map(async (milestone) => {
                        try {
                            const { payment } = await fetchPaymentForMilestone(milestone.id);
                            return [milestone.id, payment, ''];
                        } catch (err) {
                            return [milestone.id, undefined, paymentErrorMessage(err)];
                        }
                    })
                );
                if (cancelled) return;

                const nextPayments = {};
                const nextErrors = {};
                entries.forEach(([id, payment, error]) => {
                    if (error) {
                        nextErrors[id] = error;
                    } else {
                        nextPayments[id] = payment;
                    }
                });
                setPayments(nextPayments);
                setReadErrors(nextErrors);
                setLoading(false);
            } catch (err) {
                if (cancelled) return;
                setLoadError(paymentErrorMessage(err));
                setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [employmentId, reloadToken]);

    /**
     * The employer's Checkout action for one milestone.
     *
     * Create-if-needed, then initialize, then validate-then-navigate. Every step
     * is guarded against a concurrent click through busyRef, and the idempotency
     * key survives a failed attempt so a retry of the SAME creation is a replay.
     */
    const handleCheckout = useCallback(
        async (milestoneId) => {
            if (busyRef.current[milestoneId]) return;

            // Only a record the server may initialize right now: `created`, or a
            // confirmed `failed` attempt with attempts remaining. Anything else
            // (pending/paid/needs_review/exhausted) is never initialized here.
            const existing = payments[milestoneId];
            if (!canInitiatePayment(existing, isEmployer)) {
                return;
            }

            setMilestoneBusy(milestoneId, 'checkout');
            setMilestoneNotice(milestoneId, '');

            try {
                // 1. Create the record only if none exists. The key is minted once
                //    and reused across retries of this same attempt.
                if (existing === null || existing === undefined) {
                    if (!idempotencyKeys.current[milestoneId]) {
                        idempotencyKeys.current[milestoneId] = makeIdempotencyKey(milestoneId);
                    }
                    await createPaymentRecord(milestoneId, idempotencyKeys.current[milestoneId]);
                    // The server owns the record's status; read it back rather than
                    // assuming 'created'. If it is not initializable we stop here.
                    const { payment } = await fetchPaymentForMilestone(milestoneId);
                    setPayments((current) => ({ ...current, [milestoneId]: payment }));
                    if (!canInitiatePayment(payment, isEmployer)) {
                        setMilestoneNotice(
                            milestoneId,
                            paymentStatusExplanation(payment)
                        );
                        return;
                    }
                }

                // 2. Initialize. Only milestoneId is sent.
                const result = await initializePayment(milestoneId);

                // 3. Validate the response before navigating. status must still be
                //    'pending' and the URL must be an exact Paystack HTTPS host.
                if (!result || result.status !== 'pending' || !isTrustedCheckoutUrl(result.checkoutUrl)) {
                    setMilestoneNotice(
                        milestoneId,
                        'The payment service returned an unexpected response, so checkout was not started.'
                    );
                    return;
                }

                // 4. Full-page navigation to the hosted checkout. The payment's
                //    outcome is confirmed later through Refresh status -- opening
                //    this page is NOT proof of payment.
                window.location.assign(result.checkoutUrl);
            } catch (err) {
                // Ambiguous or refused: do NOT auto-retry. Report and let the
                // employer refresh the status to learn the server's state.
                setMilestoneNotice(
                    milestoneId,
                    `${paymentErrorMessage(err)} If you are unsure whether checkout started, refresh the status before trying again.`
                );
                // Re-read the record so the UI reflects whatever the server latched.
                await reloadPayment(milestoneId);
            } finally {
                setMilestoneBusy(milestoneId, undefined);
            }
        },
        [payments, reloadPayment, setMilestoneBusy, setMilestoneNotice, isEmployer]
    );

    /** The employer's manual verification: POST /payments/verify, then show the stored state. */
    const handleRefresh = useCallback(
        async (milestoneId) => {
            if (busyRef.current[milestoneId]) return;

            setMilestoneBusy(milestoneId, 'refresh');
            setMilestoneNotice(milestoneId, '');

            try {
                const result = await verifyPayment(milestoneId);
                const payment = result && result.payment ? result.payment : null;
                setPayments((current) => ({ ...current, [milestoneId]: payment }));
                // Tell the parent workspace so any already-open task-creation
                // form can re-fetch the milestone's payment and stay in sync.
                onPaymentRefreshed?.();
                setReleaseReloadToken((token) => token + 1);
                // The server is the authority: show the status it returned, never a
                // blanket "paid". `verified:false` with a needs_review/pending status
                // is displayed as exactly that.
                setMilestoneNotice(
                    milestoneId,
                    result && result.verified
                        ? `Status updated: ${paymentStatusLabel(payment)}.`
                        : paymentStatusExplanation(payment)
                );
            } catch (err) {
                setMilestoneNotice(milestoneId, paymentErrorMessage(err));
            } finally {
                setMilestoneBusy(milestoneId, undefined);
            }
        },
        [setMilestoneBusy, setMilestoneNotice, onPaymentRefreshed]
    );

    /** The employer's checkout action for the one full-contract payment. */
    const handleContractCheckout = useCallback(async () => {
        if (!contract || contractBusyRef.current) return;
        if (!canInitiatePayment(contractPayment, isEmployer)) return;

        contractBusyRef.current = true;
        setContractBusy('checkout');
        setContractNotice('');

        try {
            if (!contractPayment) {
                if (!contractIdempotencyKey.current) {
                    contractIdempotencyKey.current = makeContractIdempotencyKey(contract.id);
                }
                await createContractPaymentRecord(
                    contract.id,
                    contractIdempotencyKey.current
                );
                const { payment } = await fetchPaymentForContract(contract.id);
                setContractPayment(payment);
                if (!canInitiatePayment(payment, isEmployer)) {
                    setContractNotice(paymentStatusExplanation(payment));
                    return;
                }
            }

            const result = await initializeContractPayment(contract.id);
            if (!result || result.status !== 'pending' || !isTrustedCheckoutUrl(result.checkoutUrl)) {
                setContractNotice(
                    'The payment service returned an unexpected response, so checkout was not started.'
                );
                return;
            }

            window.location.assign(result.checkoutUrl);
        } catch (err) {
            setContractNotice(
                `${paymentErrorMessage(err)} If you are unsure whether checkout started, refresh the status before trying again.`
            );
            await reloadContractPayment(contract.id);
        } finally {
            contractBusyRef.current = false;
            setContractBusy(undefined);
        }
    }, [contract, contractPayment, reloadContractPayment, isEmployer]);

    /** The employer's manual verification for the full-contract payment. */
    const handleContractRefresh = useCallback(async () => {
        if (!contract || contractBusyRef.current) return;

        contractBusyRef.current = true;
        setContractBusy('refresh');
        setContractNotice('');

        try {
            const result = await verifyContractPayment(contract.id);
            const payment = result && result.payment ? result.payment : null;
            setContractPayment(payment);
            setReleaseReloadToken((token) => token + 1);
            setContractNotice(
                result && result.verified
                    ? `Status updated: ${paymentStatusLabel(payment)}.`
                    : paymentStatusExplanation(payment)
            );
        } catch (err) {
            setContractNotice(paymentErrorMessage(err));
        } finally {
            contractBusyRef.current = false;
            setContractBusy(undefined);
        }
    }, [contract]);

    if (loading) {
        return (
            <Card className="p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">Milestones &amp; Payment</h2>
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                    <Spinner size="sm" className="text-accent" />
                    <span>Loading milestones…</span>
                </div>
            </Card>
        );
    }

    if (loadError) {
        return (
            <Card className="p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">Milestones &amp; Payment</h2>
                <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{loadError}</span>
                </div>
            </Card>
        );
    }

    const scheduleHasMilestones = schedule.length > 0;
    const fullContract = isFullContract(contract);
    const title = fullContract ? 'Contract Payment' : 'Milestones & Payment';

    return (
        <>
            <Card className="p-6">
                <h2 className="mb-1 text-lg font-semibold text-foreground">{title}</h2>
            <p className="mb-4 text-sm text-foreground-muted">
                Payment status is confirmed by the server. Opening checkout is not proof of payment -
                after paying, return here and use Refresh status.
            </p>

            {!contract ? (
                <p className="text-foreground-muted">
                    This employment has no contract yet, so no payment can be started.
                </p>
            ) : isPendingAcceptance(contract) ? (
                <p className="text-foreground-muted">
                    The contract is awaiting the employee&apos;s acceptance. Payment opens once it is
                    active.
                </p>
            ) : !isActiveContract(contract) ? (
                <p className="text-foreground-muted">
                    Payment is not available for this contract&apos;s current status.
                </p>
            ) : fullContract ? (
                <ul className="list-none space-y-3 p-0">
                    <ContractPaymentRow
                        contract={contract}
                        payment={contractPayment}
                        readError={contractReadError}
                        isEmployer={isEmployer}
                        busy={contractBusy}
                        notice={contractNotice}
                        onCheckout={handleContractCheckout}
                        onRefresh={handleContractRefresh}
                    />
                </ul>
            ) : !scheduleHasMilestones ? (
                <p className="text-foreground-muted">
                    This contract has no milestone schedule.
                </p>
            ) : (
                <ul className="list-none space-y-3 p-0">
                    {schedule.map((milestone) => (
                        <MilestoneRow
                            key={milestone.id}
                            milestone={milestone}
                            payment={payments[milestone.id]}
                            readError={readErrors[milestone.id]}
                            isEmployer={isEmployer}
                            busy={busy[milestone.id]}
                            notice={notice[milestone.id]}
                            onCheckout={handleCheckout}
                            onRefresh={handleRefresh}
                        />
                    ))}
                </ul>
            )}
            </Card>

            {contract && isActiveContract(contract) && (
                <ReleasePanel
                    employmentId={employmentId}
                    currentUid={currentUid}
                    reloadToken={reloadToken + releaseReloadToken}
                />
            )}
        </>
    );
};

/**
 * One full-contract payment row: the agreed total, the server-reported status,
 * the employer's controls, and the last action's message. The employee sees the
 * same row read-only.
 */
const ContractPaymentRow = ({
    contract,
    payment,
    readError,
    isEmployer,
    busy,
    notice,
    onCheckout,
    onRefresh,
}) => {
    const showCheckout = !readError && canInitiatePayment(payment, isEmployer);
    const showRefresh = !readError && canRefreshStatus(payment, isEmployer);
    const isBusy = Boolean(busy);

    return (
        <li className="rounded-lg border border-border p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <p className="font-medium text-foreground">Full contract payment</p>
                    <p className="mt-1 text-sm text-foreground-muted">
                        Agreed total: {formatKoboAsNaira(contract.totalAmountMinor)}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                        <Badge variant={paymentStatusBadgeVariant(payment)}>
                            {paymentStatusLabel(payment)}
                        </Badge>
                    </div>
                    {paymentStatusExplanation(payment) && (
                        <p className="mt-2 text-sm text-foreground-muted">
                            {paymentStatusExplanation(payment)}
                        </p>
                    )}
                    {payment && typeof payment.chargeMinor === 'number' && (
                        <p className="mt-1 text-xs text-foreground-subtle">
                            Total charge: {formatKoboAsNaira(payment.chargeMinor)} (set by the server)
                        </p>
                    )}
                    {readError && (
                        <p className="mt-2 text-sm text-danger">Payment status could not be loaded.</p>
                    )}
                </div>

                {isEmployer && (showCheckout || showRefresh) && (
                    <div className="flex shrink-0 gap-2">
                        {showCheckout && (
                            <Button
                                type="button"
                                variant="primary"
                                disabled={isBusy}
                                aria-busy={isBusy && busy === 'checkout'}
                                onClick={onCheckout}
                            >
                                {busy === 'checkout' ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <CreditCard className="h-4 w-4" aria-hidden="true" />
                                )}
                                Checkout
                            </Button>
                        )}
                        {showRefresh && (
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={isBusy}
                                aria-busy={isBusy && busy === 'refresh'}
                                onClick={onRefresh}
                            >
                                {busy === 'refresh' ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                                )}
                                Refresh status
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {notice && (
                <p role="status" className="mt-3 text-sm text-foreground-muted">
                    {notice}
                </p>
            )}
        </li>
    );
};

/**
 * One milestone row: label, server-reported amount and status, the employer's
 * controls, and the last action's message.
 */
const MilestoneRow = ({
    milestone,
    payment,
    readError,
    isEmployer,
    busy,
    notice,
    onCheckout,
    onRefresh,
}) => {
    const showCheckout = !readError && canInitiatePayment(payment, isEmployer);
    const showRefresh = !readError && canRefreshStatus(payment, isEmployer);
    const isBusy = Boolean(busy);

    return (
        <li className="rounded-lg border border-border p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <p className="font-medium text-foreground">{milestone.label || milestone.id}</p>
                    <p className="mt-1 text-sm text-foreground-muted">
                        Amount: {formatKoboAsNaira(milestone.amountMinor)}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                        <Badge variant={paymentStatusBadgeVariant(payment)}>
                            {paymentStatusLabel(payment)}
                        </Badge>
                    </div>
                    {paymentStatusExplanation(payment) && (
                        <p className="mt-2 text-sm text-foreground-muted">
                            {paymentStatusExplanation(payment)}
                        </p>
                    )}
                    {payment && typeof payment.chargeMinor === 'number' && (
                        <p className="mt-1 text-xs text-foreground-subtle">
                            Total charge: {formatKoboAsNaira(payment.chargeMinor)} (set by the server)
                        </p>
                    )}
                    {readError && (
                        <p className="mt-2 text-sm text-danger">Payment status could not be loaded.</p>
                    )}
                </div>

                {isEmployer && (showCheckout || showRefresh) && (
                    <div className="flex shrink-0 gap-2">
                        {showCheckout && (
                            <Button
                                type="button"
                                variant="primary"
                                disabled={isBusy}
                                aria-busy={isBusy && busy === 'checkout'}
                                onClick={() => onCheckout(milestone.id)}
                            >
                                {busy === 'checkout' ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <CreditCard className="h-4 w-4" aria-hidden="true" />
                                )}
                                Checkout
                            </Button>
                        )}
                        {showRefresh && (
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={isBusy}
                                aria-busy={isBusy && busy === 'refresh'}
                                onClick={() => onRefresh(milestone.id)}
                            >
                                {busy === 'refresh' ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                                )}
                                Refresh status
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {notice && (
                <p role="status" className="mt-3 text-sm text-foreground-muted">
                    {notice}
                </p>
            )}
        </li>
    );
};

export default MilestonePaymentPanel;
