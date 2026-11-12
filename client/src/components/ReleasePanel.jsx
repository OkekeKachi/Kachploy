import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    Loader2,
    RefreshCw,
    Send,
    Wallet,
} from 'lucide-react';
import Card from './ui/Card';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import {
    approveRelease,
    createReleaseRequest,
    fetchPayoutBanks,
    fetchReleaseWorkspace,
    reconcileRelease,
    resolvePayoutAccount,
    savePayoutAccount,
} from '../api';
import { formatKoboAsNaira } from './paymentPresentation';
import {
    releaseErrorMessage,
    releaseStatusBadgeVariant,
    releaseStatusExplanation,
    releaseStatusLabel,
    targetAction,
    targetActionLabel,
    targetAmountMinor,
    targetRelease,
} from './releasePresentation';

const EMPTY_PAYOUT_FORM = {
    bankAccountNumber: '',
    bankCode: '',
    bankName: '',
    accountName: '',
};

const eligibilityMessage = (eligibility) => {
    if (!eligibility) return '';
    switch (eligibility.reason) {
        case 'no_tasks':
            return 'No work has been assigned to this employment yet.';
        case 'work_not_approved':
            return 'All work must be approved before its payment can be released.';
        case 'funding_not_confirmed':
            return 'The payment must be confirmed before it can be released.';
        case 'open_dispute':
            return 'A release is blocked while a dispute is open.';
        case 'already_released':
            return 'This payment has already been released.';
        case 'all_tasks_settled':
            return 'All work is settled and its payment is confirmed.';
        default:
            return 'No release is available for this employment yet.';
    }
};

const ReleasePanel = ({ employmentId, currentUid, reloadToken = 0 }) => {
    const [workspace, setWorkspace] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [actionError, setActionError] = useState('');
    const [notice, setNotice] = useState('');
    const [busyTarget, setBusyTarget] = useState('');
    const busyTargetRef = useRef('');
    const [payoutForm, setPayoutForm] = useState(EMPTY_PAYOUT_FORM);
    const [payoutBusy, setPayoutBusy] = useState(false);
    const [payoutNotice, setPayoutNotice] = useState('');
    const [payoutError, setPayoutError] = useState('');
    const [payoutVerified, setPayoutVerified] = useState(false);
    const [payoutVerifying, setPayoutVerifying] = useState(false);
    const [banks, setBanks] = useState([]);
    const [banksLoading, setBanksLoading] = useState(false);
    const [banksError, setBanksError] = useState('');
    const [bankQuery, setBankQuery] = useState('');
    const [bankReloadToken, setBankReloadToken] = useState(0);

    const loadWorkspace = useCallback(async () => {
        const data = await fetchReleaseWorkspace(employmentId);
        setWorkspace(data);
        return data;
    }, [employmentId]);

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

        fetchReleaseWorkspace(employmentId)
            .then((data) => {
                if (!cancelled) setWorkspace(data);
            })
            .catch((error) => {
                if (!cancelled) {
                    setLoadError(
                        releaseErrorMessage(error, 'Release status could not be loaded.')
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [employmentId, currentUid, reloadToken]);

    useEffect(() => {
        if (!workspace || !workspace.payoutAccount || !workspace.payoutAccount.configured) {
            return;
        }
        setPayoutForm((current) => ({
            ...current,
            bankCode: current.bankCode || workspace.payoutAccount.bankCode || '',
            bankName: current.bankName || workspace.payoutAccount.bankName || '',
            accountName: current.accountName || workspace.payoutAccount.accountName || '',
        }));
    }, [workspace]);

    const isEmployee = Boolean(
        workspace && currentUid && workspace.employeeId === currentUid
    );
    const isEmployer = Boolean(
        workspace && currentUid && workspace.employerId === currentUid
    );

    useEffect(() => {
        if (!isEmployee) return undefined;

        let cancelled = false;
        setBanksLoading(true);
        setBanksError('');

        fetchPayoutBanks()
            .then((data) => {
                if (!cancelled) setBanks(Array.isArray(data.banks) ? data.banks : []);
            })
            .catch((error) => {
                if (!cancelled) {
                    setBanks([]);
                    setBanksError(
                        releaseErrorMessage(error, 'The bank list could not be loaded.')
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setBanksLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [isEmployee, bankReloadToken]);

    const selectedBank = banks.find((bank) => bank.code === payoutForm.bankCode);
    const normalizedQuery = bankQuery.trim().toLowerCase();
    let visibleBanks = normalizedQuery
        ? banks.filter(
            (bank) =>
                bank.name.toLowerCase().includes(normalizedQuery)
                || bank.code.includes(normalizedQuery)
        )
        : banks;

    if (
        selectedBank
        && !visibleBanks.some((bank) => bank.code === selectedBank.code)
    ) {
        visibleBanks = [selectedBank, ...visibleBanks];
    }

    const updatePayoutField = (field, value) => {
        setPayoutForm((current) => ({
            ...current,
            [field]: value,
            ...(field === 'bankCode'
                ? {
                    bankName:
                        banks.find((bank) => bank.code === value)?.name || '',
                }
                : {}),
            ...(field === 'bankAccountNumber' || field === 'bankCode'
                ? { accountName: '' }
                : {}),
        }));
        setPayoutVerified(false);
        setPayoutNotice('');
        setPayoutError('');
    };

    const handlePayoutVerify = async () => {
        if (payoutVerifying) return;

        setPayoutVerifying(true);
        setPayoutError('');
        setPayoutNotice('');
        setPayoutVerified(false);

        try {
            const data = await resolvePayoutAccount({
                bankAccountNumber: payoutForm.bankAccountNumber,
                bankCode: payoutForm.bankCode,
            });
            const resolved = data.payoutAccount || {};
            setPayoutForm((current) => ({
                ...current,
                bankCode: resolved.bankCode || current.bankCode,
                bankName: resolved.bankName || current.bankName,
                accountName: resolved.accountName || '',
            }));
            setPayoutVerified(Boolean(resolved.accountName));
            setPayoutNotice(
                resolved.accountName
                    ? `Verified account name: ${resolved.accountName}`
                    : ''
            );
        } catch (error) {
            setPayoutError(
                releaseErrorMessage(error, 'The payout account could not be verified.')
            );
        } finally {
            setPayoutVerifying(false);
        }
    };

    const handlePayoutSubmit = async (event) => {
        event.preventDefault();
        if (payoutBusy) return;
        if (!payoutVerified) {
            setPayoutError('Verify the bank account before saving it.');
            return;
        }

        setPayoutBusy(true);
        setPayoutError('');
        setPayoutNotice('');

        try {
            await savePayoutAccount({
                bankAccountNumber: payoutForm.bankAccountNumber,
                bankCode: payoutForm.bankCode,
            });
            const data = await loadWorkspace();
            setPayoutForm((current) => ({
                ...current,
                bankAccountNumber: '',
                bankCode: data.payoutAccount?.bankCode || current.bankCode,
                bankName: data.payoutAccount?.bankName || current.bankName,
                accountName: data.payoutAccount?.accountName || current.accountName,
            }));
            setPayoutVerified(false);
            setPayoutNotice('Payout account saved.');
        } catch (error) {
            setPayoutError(
                releaseErrorMessage(error, 'The payout account could not be saved.')
            );
        } finally {
            setPayoutBusy(false);
        }
    };

    const runTargetAction = async (target) => {
        const key = `${target.targetType}:${target.targetId}`;
        if (busyTargetRef.current) return;

        busyTargetRef.current = key;
        setBusyTarget(key);
        setActionError('');
        setNotice('');

        try {
            const release = targetRelease(workspace, target);
            const action = targetAction(release);

            if (action === 'approve') {
                let releaseId = release?.releaseId || target.releaseId;
                if (!release) {
                    const created = await createReleaseRequest(
                        target.targetType,
                        target.targetId
                    );
                    releaseId = created.release?.id || releaseId;
                }

                const result = await approveRelease(releaseId);
                if (result.outcome === 'succeeded') {
                    setNotice('Payout sent and confirmed by the provider.');
                } else if (result.outcome === 'failed') {
                    setNotice('The provider reported that this payout failed.');
                } else {
                    setNotice(
                        'The payout outcome is not confirmed yet. Use Check status to reconcile it.'
                    );
                }
            } else if (action === 'reconcile') {
                await reconcileRelease(release.releaseId);
                setNotice('Release status checked against the provider.');
            }

            await loadWorkspace();
        } catch (error) {
            setActionError(
                releaseErrorMessage(error, 'The release action could not be completed.')
            );
        } finally {
            busyTargetRef.current = '';
            setBusyTarget('');
        }
    };

    if (loading) {
        return (
            <Card className="mt-6 p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">
                    Payout &amp; Release
                </h2>
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                    <Spinner size="sm" className="text-accent" />
                    <span>Loading release status...</span>
                </div>
            </Card>
        );
    }

    if (loadError) {
        return (
            <Card className="mt-6 p-6">
                <h2 className="mb-4 text-lg font-semibold text-foreground">
                    Payout &amp; Release
                </h2>
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

    if (!workspace) return null;

    const targets = Array.isArray(workspace.targets) ? workspace.targets : [];
    const payoutReady = Boolean(workspace.payoutAccount?.configured);

    return (
        <Card className="mt-6 p-6">
            <h2 className="mb-1 text-lg font-semibold text-foreground">Payout &amp; Release</h2>
            <p className="mb-4 text-sm text-foreground-muted">
                Releases are authorized by the employer and confirmed by the payment provider.
                Only the server decides whether a payout succeeded.
            </p>

            <div className="mb-5 rounded-lg border border-border p-4">
                <div className="flex items-start gap-3">
                    <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground">Payout account</p>
                        {payoutReady ? (
                            <p className="mt-1 text-sm text-foreground-muted">
                                {isEmployee && workspace.payoutAccount.accountNumberLast4
                                    ? `${workspace.payoutAccount.accountName || 'Account'} ending ${workspace.payoutAccount.accountNumberLast4}`
                                    : 'The employee has added a payout account.'}
                            </p>
                        ) : (
                            <p className="mt-1 text-sm text-foreground-muted">
                                {isEmployee
                                    ? 'Add your bank account before a release can be sent to you.'
                                    : 'The employee has not added a payout account yet.'}
                            </p>
                        )}
                    </div>
                </div>

                {isEmployee && (
                    <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={handlePayoutSubmit}>
                        <label className="text-sm text-foreground-muted">
                            Account number
                            <input
                                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                                inputMode="numeric"
                                autoComplete="off"
                                maxLength={10}
                                pattern="[0-9]{10}"
                                required
                                placeholder="0123456789"
                                value={payoutForm.bankAccountNumber}
                                onChange={(event) =>
                                    updatePayoutField(
                                        'bankAccountNumber',
                                        event.target.value.replace(/\D/g, '')
                                    )
                                }
                            />
                        </label>
                        <label className="text-sm text-foreground-muted">
                            Search banks
                            <input
                                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                                type="search"
                                autoComplete="off"
                                placeholder="Access Bank or 044"
                                value={bankQuery}
                                onChange={(event) => setBankQuery(event.target.value)}
                            />
                        </label>
                        <label className="text-sm text-foreground-muted">
                            Bank
                            <select
                                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                                required
                                disabled={banksLoading || Boolean(banksError)}
                                value={payoutForm.bankCode}
                                onChange={(event) =>
                                    updatePayoutField('bankCode', event.target.value)
                                }
                            >
                                <option value="">
                                    {banksLoading ? 'Loading banks...' : 'Select a bank'}
                                </option>
                                {visibleBanks.map((bank) => (
                                    <option key={bank.code} value={bank.code}>
                                        {bank.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="text-sm text-foreground-muted">
                            Verified account name
                            <input
                                className="mt-1 w-full rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground"
                                autoComplete="off"
                                readOnly
                                required
                                maxLength={100}
                                placeholder="Verify to load the account name"
                                value={payoutForm.accountName}
                            />
                        </label>
                        {banksError && (
                            <div className="text-sm text-danger sm:col-span-2">
                                <span>{banksError}</span>{' '}
                                <button
                                    type="button"
                                    className="font-medium underline"
                                    onClick={() => setBankReloadToken((token) => token + 1)}
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 sm:col-span-2">
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                    payoutVerifying
                                    || !/^\d{10}$/.test(payoutForm.bankAccountNumber)
                                    || !payoutForm.bankCode
                                }
                                onClick={handlePayoutVerify}
                            >
                                {payoutVerifying ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                                )}
                                Verify account
                            </Button>
                            <Button
                                type="submit"
                                variant="secondary"
                                disabled={payoutBusy || !payoutVerified}
                            >
                                {payoutBusy ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <Wallet className="h-4 w-4" aria-hidden="true" />
                                )}
                                Save payout account
                            </Button>
                        </div>
                    </form>
                )}

                {payoutNotice && (
                    <p role="status" className="mt-3 flex items-center gap-2 text-sm text-success">
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        {payoutNotice}
                    </p>
                )}
                {payoutError && (
                    <p role="alert" className="mt-3 text-sm text-danger">
                        {payoutError}
                    </p>
                )}
            </div>

            {actionError && (
                <div
                    role="alert"
                    className="mb-4 flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{actionError}</span>
                </div>
            )}
            {notice && (
                <p role="status" className="mb-4 text-sm text-foreground-muted">
                    {notice}
                </p>
            )}

            {targets.length === 0 ? (
                <div className="rounded-md bg-surface-muted px-4 py-3 text-sm text-foreground-muted">
                    <p>{eligibilityMessage(workspace.eligibility)}</p>
                </div>
            ) : (
                <ul className="list-none space-y-3 p-0">
                    {targets.map((target) => {
                        const release = targetRelease(workspace, target);
                        const action = targetAction(release);
                        const key = `${target.targetType}:${target.targetId}`;
                        const isBusy = busyTarget === key;
                        const amountMinor = targetAmountMinor(target);
                        const approveNeedsPayout = action === 'approve' && !payoutReady;

                        return (
                            <li key={key} className="rounded-lg border border-border p-4">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <p className="font-medium text-foreground">
                                            {target.label || target.targetId}
                                        </p>
                                        {amountMinor !== null && (
                                            <p className="mt-1 text-sm text-foreground-muted">
                                                Amount: {formatKoboAsNaira(amountMinor)}
                                            </p>
                                        )}
                                        <div className="mt-2 flex items-center gap-2">
                                            <Badge variant={releaseStatusBadgeVariant(release)}>
                                                {releaseStatusLabel(release)}
                                            </Badge>
                                            {release?.lastProviderReference && (
                                                <span className="text-xs text-foreground-subtle">
                                                    Reference {release.lastProviderReference}
                                                </span>
                                            )}
                                        </div>
                                        {releaseStatusExplanation(release) && (
                                            <p className="mt-2 text-sm text-foreground-muted">
                                                {releaseStatusExplanation(release)}
                                            </p>
                                        )}
                                        {release?.lastFailureReason && (
                                            <p className="mt-1 text-xs text-foreground-subtle">
                                                Reason: {release.lastFailureReason}
                                            </p>
                                        )}
                                        {isEmployer && approveNeedsPayout && (
                                            <p className="mt-2 text-sm text-warning">
                                                The employee must add a payout account first.
                                            </p>
                                        )}
                                    </div>

                                    {isEmployer && action && (
                                        <div className="shrink-0">
                                            <Button
                                                type="button"
                                                variant={action === 'approve' ? 'primary' : 'secondary'}
                                                disabled={isBusy || approveNeedsPayout}
                                                aria-busy={isBusy}
                                                onClick={() => runTargetAction(target)}
                                            >
                                                {isBusy ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                                ) : action === 'reconcile' ? (
                                                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                                                ) : (
                                                    <Send className="h-4 w-4" aria-hidden="true" />
                                                )}
                                                {targetActionLabel(release)}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </Card>
    );
};

export default ReleasePanel;
