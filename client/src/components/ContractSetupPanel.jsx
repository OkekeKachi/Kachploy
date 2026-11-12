import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import Card from './ui/Card';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import { Input, Field } from './ui/Field';
import { acceptContract, createContract, fetchContractForEmployment } from '../api';
import {
    CONTRACT_PAYMENT_MODES,
    MAX_MILESTONES,
    PAYMENT_MODE_LABELS,
    buildContractPayload,
    contractErrorMessage,
    contractStatusBadgeVariant,
    contractStatusLabel,
    formatKoboAsNaira,
    isActiveContract,
    isPendingAcceptance,
} from './contractPresentation';

/**
 * STAGE 1I.3. The contract workflow for ONE employment, in the shared
 * EmployeeWorkspace (the employer's and the employee's view of a single hire).
 *
 * WHAT THIS IS. The missing half of the payment journey. Before any milestone can
 * be paid, the two parties must agree on a contract, and until now nothing in the
 * UI created one -- so the Milestones & Payment panel simply read "Contract not
 * found" after a hire. This component:
 *
 *   * lets the EMPLOYER create the contract (one total, or independent
 *     milestone payment obligations);
 *   * shows the EMPLOYEE the pending contract and lets them accept it;
 *   * shows both parties the active contract;
 *   * and asks the payment panel to reload once the contract changes, so the
 *     agreed payment becomes available.
 *
 * THE SERVER OWNS EVERYTHING THAT MATTERS. Identity, the agreed amount's
 * commission, the status transitions and task-to-milestone ownership are all
 * enforced server-side (requireContractEmployer / requireContractEmployee and
 * contractService). This component decides only what to OFFER: which of create /
 * accept / nothing to draw, based on the contract's status and whether the signed
 * -in uid is the employment's employer or employee. That is a UI convenience, not
 * a security boundary -- a forged request is refused by the guard, not by hiding
 * a button.
 *
 * NO PAYMENT IS STARTED HERE. Creating or accepting a contract initiates no
 * Paystack call and writes no payment record. Checkout stays entirely in the
 * payment panel and only becomes meaningful once the contract is active (and,
 * for a milestone contract, every task associated with it is approved).
 */

// A blank milestone form row. The amount starts empty (a string, because the
// employer types naira).
const emptyMilestoneRow = () => ({ label: '', amountNaira: '' });

const ContractSetupPanel = ({ employment, currentUid, onChanged, onContractLoaded }) => {
    const employmentId = employment && employment.id;

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [contract, setContract] = useState(null);

    const isEmployer = Boolean(employment && currentUid && employment.employerId === currentUid);

    /**
     * Re-reads the contract for this employment. A 404 is the normal "no contract
     * yet" state (fetchContractForEmployment maps it to `{ contract: null }`).
     */
    const reloadContract = useCallback(async () => {
        if (!employmentId) {
            setLoading(false);
            return;
        }

        setLoading(true);
        setLoadError('');

        try {
            const { contract: loaded } = await fetchContractForEmployment(employmentId);
            setContract(loaded);
            onContractLoaded?.(loaded);
        } catch (err) {
            setLoadError(contractErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [employmentId, onContractLoaded]);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            if (!employmentId) {
                setLoading(false);
                return;
            }

            setLoading(true);
            setLoadError('');

            try {
                const { contract: loaded } = await fetchContractForEmployment(employmentId);
                if (!cancelled) {
                    setContract(loaded);
                    onContractLoaded?.(loaded);
                }
            } catch (err) {
                if (!cancelled) setLoadError(contractErrorMessage(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [employmentId, onContractLoaded]);

    if (loading) {
        return (
            <Card className="mb-6 p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">Contract</h2>
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                    <Spinner size="sm" className="text-accent" />
                    <span>Loading contract…</span>
                </div>
            </Card>
        );
    }

    if (loadError) {
        return (
            <Card className="mb-6 p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">Contract</h2>
                <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{loadError}</span>
                </div>
                <Button type="button" variant="secondary" className="mt-4" onClick={reloadContract}>
                    Retry
                </Button>
            </Card>
        );
    }

    // Active: both parties see the agreed terms. Nothing to create or accept.
    if (isActiveContract(contract)) {
        return (
            <Card className="mb-6 p-6">
                <div className="mb-4 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
                    <h2 className="text-lg font-semibold text-foreground">Contract</h2>
                    <Badge variant={contractStatusBadgeVariant(contract)}>
                        {contractStatusLabel(contract)}
                    </Badge>
                </div>
                <ContractSummary contract={contract} />
                <p className="mt-4 text-sm text-foreground-muted">
                    This contract has been accepted by both parties. Payment is handled in the
                    payment section below.
                </p>
            </Card>
        );
    }

    // Pending acceptance.
    if (isPendingAcceptance(contract)) {
        return (
            <Card className="mb-6 p-6">
                <div className="mb-4 flex items-center gap-2">
                    <FileText className="h-5 w-5 text-info" aria-hidden="true" />
                    <h2 className="text-lg font-semibold text-foreground">Contract</h2>
                    <Badge variant={contractStatusBadgeVariant(contract)}>
                        {contractStatusLabel(contract)}
                    </Badge>
                </div>
                <ContractSummary contract={contract} />

                {isEmployer ? (
                    <p className="mt-4 text-sm text-foreground-muted">
                        Waiting for the employee to accept this contract. They will see it on their own
                        view of this employment.
                    </p>
                ) : (
                    <AcceptContractAction contract={contract} onAccepted={onChanged} />
                )}
            </Card>
        );
    }

    // No contract yet.
    if (isEmployer) {
        return (
            <Card className="mb-6 p-6">
                <h2 className="mb-1 text-lg font-semibold text-foreground">Contract</h2>
                <p className="mb-4 text-sm text-foreground-muted">
                    Agree the price for this employment before payment can be made. The employee will
                    be asked to accept it.
                </p>
                <CreateContractForm
                    employment={employment}
                    onCreated={reloadContract}
                    onChanged={onChanged}
                />
            </Card>
        );
    }

    // Employee, no contract yet.
    return (
        <Card className="mb-6 p-6">
            <h2 className="mb-4 text-lg font-semibold text-foreground">Contract</h2>
            <p className="text-foreground-muted">
                No contract has been created for this employment yet. Your employer creates it; you will
                be asked to accept it before any payment is made.
            </p>
        </Card>
    );
};

/** Read-only agreed terms, shared by the pending and active states. */
const ContractSummary = ({ contract }) => {
    if (!contract) return null;

    const mode = contract.paymentMode;

    return (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
                <dt className="text-xs uppercase tracking-wide text-foreground-subtle">Agreed total</dt>
                <dd className="text-foreground">{formatKoboAsNaira(contract.totalAmountMinor)}</dd>
            </div>
            <div>
                <dt className="text-xs uppercase tracking-wide text-foreground-subtle">Payment type</dt>
                <dd className="text-foreground">{PAYMENT_MODE_LABELS[mode] || 'Not specified'}</dd>
            </div>
            <div>
                <dt className="text-xs uppercase tracking-wide text-foreground-subtle">Currency</dt>
                <dd className="text-foreground">{contract.currency || 'NGN'}</dd>
            </div>
        </dl>
    );
};

/**
 * The employee's accept action. Sends POST /contracts/:employmentId/accept and
 * reports the server's outcome. A repeat acceptance is refused by the server
 * (400), which is shown as a readable message rather than hidden.
 */
const AcceptContractAction = ({ contract, onAccepted }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [accepted, setAccepted] = useState(false);

    const handleAccept = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setError('');

        try {
            await acceptContract(contract.id);
            setAccepted(true);
            // The status is now active; tell the parent so the payment panel reloads.
            if (onAccepted) onAccepted();
        } catch (err) {
            setError(contractErrorMessage(err));
        } finally {
            setBusy(false);
        }
    }, [busy, contract.id, onAccepted]);

    if (accepted) {
        return (
            <div
                role="status"
                className="mt-4 flex items-center gap-2 rounded-md bg-success-subtle px-4 py-3 text-sm text-success-subtle-foreground"
            >
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Contract accepted. Reloading…</span>
            </div>
        );
    }

    return (
        <div className="mt-4">
            <p className="mb-3 text-sm text-foreground-muted">
                Accepting confirms you agree to these terms. No payment happens now.
            </p>
            <Button type="button" variant="primary" disabled={busy} aria-busy={busy} onClick={handleAccept}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Accept contract
            </Button>
            {error && (
                <p role="alert" className="mt-3 text-sm text-danger">
                    {error}
                </p>
            )}
        </div>
    );
};

/**
 * The employer's create form. Two payment modes; in `milestones` mode each row
 * is an independent payment obligation. Tasks are assigned separately and opt
 * into a milestone by carrying its id.
 */
const CreateContractForm = ({ employment, onCreated, onChanged }) => {
    const [paymentMode, setPaymentMode] = useState('full');
    const [totalNaira, setTotalNaira] = useState('');
    const [milestones, setMilestones] = useState([emptyMilestoneRow()]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const busyRef = useRef(false);

    const updateMilestone = useCallback((index, patch) => {
        setMilestones((current) =>
            current.map((row, i) => (i === index ? { ...row, ...patch } : row))
        );
    }, []);

    const addMilestone = useCallback(() => {
        setMilestones((current) => (current.length >= MAX_MILESTONES ? current : [...current, emptyMilestoneRow()]));
    }, []);

    const removeMilestone = useCallback((index) => {
        setMilestones((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
    }, []);

    const handleSubmit = useCallback(
        async (event) => {
            event.preventDefault();
            if (busyRef.current) return;

            const { ok, payload, error: buildError } = buildContractPayload({
                employmentId: employment.id,
                paymentMode,
                totalNaira,
                milestones,
            });

            if (!ok) {
                setError(buildError);
                return;
            }

            busyRef.current = true;
            setBusy(true);
            setError('');

            try {
                await createContract(payload);
                // Re-read the contract so the panel shows the server's stored
                // document, and ask the parent to reload the payment panel.
                if (onCreated) await onCreated();
                if (onChanged) onChanged();
            } catch (err) {
                setError(contractErrorMessage(err));
            } finally {
                busyRef.current = false;
                setBusy(false);
            }
        },
        [employment.id, paymentMode, totalNaira, milestones, onCreated, onChanged]
    );

    return (
        <form onSubmit={handleSubmit}>
            <fieldset className="mb-4">
                <legend className="mb-2 text-sm font-medium text-foreground">How is this paid?</legend>
                <div className="flex flex-wrap gap-2">
                    {CONTRACT_PAYMENT_MODES.map((mode) => (
                        <label
                            key={mode}
                            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                                paymentMode === mode
                                    ? 'border-accent bg-accent-subtle text-accent-subtle-foreground'
                                    : 'border-border-strong bg-surface text-foreground'
                            }`}
                        >
                            <input
                                type="radio"
                                name="paymentMode"
                                value={mode}
                                checked={paymentMode === mode}
                                onChange={() => setPaymentMode(mode)}
                            />
                            {PAYMENT_MODE_LABELS[mode]}
                        </label>
                    ))}
                </div>
            </fieldset>

            {paymentMode === 'full' ? (
                <Field
                    id="contract-total"
                    label="Agreed total (naira)"
                    hint="The full price for this employment. The platform commission is added by the server."
                >
                    <Input
                        id="contract-total"
                        inputMode="decimal"
                        value={totalNaira}
                        onChange={(event) => setTotalNaira(event.target.value)}
                        placeholder="5000"
                    />
                </Field>
            ) : (
                <div>
                    <p className="mb-2 text-sm text-foreground-muted">
                        Set the payment stages for this job. Tasks are assigned separately and can
                        be linked to a milestone when they are created.
                    </p>
                    <ul className="list-none space-y-3 p-0">
                        {milestones.map((row, index) => (
                            <li key={index} className="rounded-lg border border-border p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="text-sm font-medium text-foreground">
                                        Milestone {index + 1}
                                    </span>
                                    {milestones.length > 1 && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => removeMilestone(index)}
                                            aria-label={`Remove milestone ${index + 1}`}
                                        >
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <Field id={`ms-label-${index}`} label="Label">
                                        <Input
                                            id={`ms-label-${index}`}
                                            value={row.label}
                                            onChange={(event) =>
                                                updateMilestone(index, { label: event.target.value })
                                            }
                                            placeholder="e.g. Strip out kitchen"
                                        />
                                    </Field>
                                    <Field id={`ms-amount-${index}`} label="Amount (naira)">
                                        <Input
                                            id={`ms-amount-${index}`}
                                            inputMode="decimal"
                                            value={row.amountNaira}
                                            onChange={(event) =>
                                                updateMilestone(index, { amountNaira: event.target.value })
                                            }
                                            placeholder="1500"
                                        />
                                    </Field>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {milestones.length < MAX_MILESTONES && (
                        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={addMilestone}>
                            <Plus className="h-4 w-4" aria-hidden="true" />
                            Add milestone
                        </Button>
                    )}
                </div>
            )}

            {error && (
                <p role="alert" className="mt-4 text-sm text-danger">
                    {error}
                </p>
            )}

            <div className="mt-5">
                <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    Create contract
                </Button>
                <p className="mt-2 text-xs text-foreground-subtle">
                    This records the agreed price. It charges nobody and starts no payment.
                </p>
            </div>
        </form>
    );
};

export default ContractSetupPanel;
