import { useQuery } from '@tanstack/react-query';
import api, {
    fetchContractForEmployment,
    fetchContractProposalsForApplication,
    fetchPaymentHistory,
} from './api';
import queryKeys from './queryKeys';

const readJob = async (jobId) => {
    const res = await api.get(`/jobs/${jobId}`);
    return res.data.job || null;
};

const readEmployeeApplications = async (uid) => {
    const res = await api.get(`/applications/employee/${uid}`);
    return res.data.applications || [];
};

const readJobApplications = async (jobId) => {
    const res = await api.get(`/applications/job/${jobId}`);
    return res.data.applications || [];
};

const readJobInterviews = async (jobId) => {
    const res = await api.get(`/interviews/job/${jobId}`);
    return res.data.interviews || [];
};

const readApplicationInterviews = async (applicationId) => {
    const res = await api.get(`/interviews/application/${applicationId}`);
    return res.data.interviews || [];
};

const readJobTasks = async (jobId) => {
    const res = await api.get(`/tasks/job/${jobId}`);
    return res.data.tasks || [];
};

const readEmployeeTasks = async (uid) => {
    const res = await api.get(`/tasks/employee/${uid}`);
    return res.data.tasks || [];
};

const readJobEmployments = async (jobId) => {
    const res = await api.get(`/employments/job/${jobId}`);
    return res.data.employments || [];
};

const readEmployeeEmployments = async (uid) => {
    const res = await api.get(`/employments/employee/${uid}`);
    return res.data.employments || [];
};

const readContract = async (employmentId) => {
    const { contract, milestones } = await fetchContractForEmployment(employmentId);
    return { contract, milestones };
};

const readContractProposals = async (applicationId) => {
    const data = await fetchContractProposalsForApplication(applicationId);
    return data.proposals || [];
};

const readPublicUser = async (uid) => {
    const res = await api.get(`/users/getUser/${uid}`);
    return (res.data && res.data.user) || null;
};

export const fetchJob = readJob;
export const fetchEmployeeApplications = readEmployeeApplications;
export const fetchJobApplications = readJobApplications;
export const fetchJobInterviews = readJobInterviews;
export const fetchApplicationInterviews = readApplicationInterviews;
export const fetchJobTasks = readJobTasks;
export const fetchEmployeeTasks = readEmployeeTasks;
export const fetchJobEmployments = readJobEmployments;
export const fetchEmployeeEmployments = readEmployeeEmployments;
export const fetchContract = readContract;
export const fetchContractProposals = readContractProposals;
export const fetchPublicUser = readPublicUser;

export const useJobQuery = (jobId, options) =>
    useQuery({
        queryKey: queryKeys.job(jobId),
        queryFn: () => readJob(jobId),
        enabled: Boolean(jobId),
        retry: false,
        ...options,
    });

export const useEmployeeApplicationsQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.employeeApplications(uid),
        queryFn: () => readEmployeeApplications(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

export const useJobApplicationsQuery = (jobId, options) =>
    useQuery({
        queryKey: queryKeys.jobApplications(jobId),
        queryFn: () => readJobApplications(jobId),
        enabled: Boolean(jobId),
        retry: false,
        ...options,
    });

export const useJobInterviewsQuery = (jobId, options) =>
    useQuery({
        queryKey: queryKeys.jobInterviews(jobId),
        queryFn: () => readJobInterviews(jobId),
        enabled: Boolean(jobId),
        retry: false,
        ...options,
    });

export const useApplicationInterviewsQuery = (applicationId, options) =>
    useQuery({
        queryKey: queryKeys.applicationInterviews(applicationId),
        queryFn: () => readApplicationInterviews(applicationId),
        enabled: Boolean(applicationId),
        retry: false,
        ...options,
    });

export const useJobTasksQuery = (jobId, options) =>
    useQuery({
        queryKey: queryKeys.jobTasks(jobId),
        queryFn: () => readJobTasks(jobId),
        enabled: Boolean(jobId),
        retry: false,
        ...options,
    });

export const useEmployeeTasksQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.employeeTasks(uid),
        queryFn: () => readEmployeeTasks(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

export const useJobEmploymentsQuery = (jobId, options) =>
    useQuery({
        queryKey: queryKeys.jobEmployments(jobId),
        queryFn: () => readJobEmployments(jobId),
        enabled: Boolean(jobId),
        retry: false,
        ...options,
    });

export const useEmployeeEmploymentsQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.employeeEmployments(uid),
        queryFn: () => readEmployeeEmployments(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

export const useContractQuery = (employmentId, options) =>
    useQuery({
        queryKey: queryKeys.contract(employmentId),
        queryFn: () => readContract(employmentId),
        enabled: Boolean(employmentId),
        retry: false,
        ...options,
    });

export const useContractProposalsQuery = (applicationId, options) =>
    useQuery({
        queryKey: queryKeys.contractProposals(applicationId),
        queryFn: () => readContractProposals(applicationId),
        enabled: Boolean(applicationId),
        retry: false,
        ...options,
    });

export const usePublicUserQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.publicUser(uid),
        queryFn: () => readPublicUser(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

export const usePaymentHistoryQuery = (uid, params, options) =>
    useQuery({
        queryKey: queryKeys.paymentHistory(uid, params),
        queryFn: () => fetchPaymentHistory(params),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });
