import React, { useRef, useState } from 'react';
import { auth } from '../firebase';
import api from '../api';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import AppNavbar from '../components/AppNavbar';
import {
    Briefcase,
    CheckSquare,
    List,
    Calendar,
    DollarSign,
    Tags,
    Plus,
    X,
    AlertCircle,
} from 'lucide-react';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { Field, Input, Textarea, Select } from '../components/ui/Field';
import queryKeys from '../queryKeys';
import { useUserQuery } from '../useUserQuery';

// Mock skill suggestions - replace with your actual import
const skillSuggestions = [
    'JavaScript', 'React', 'Node.js', 'Python', 'TypeScript', 'HTML/CSS',
    'MongoDB', 'PostgreSQL', 'AWS', 'Docker', 'Git', 'GraphQL',
    'Vue.js', 'Angular', 'Express.js', 'Django', 'Flask', 'MySQL'
];

/*
  STAGE 11.5: presentation-only redesign.

  Everything below (state, the fetchUser effect, handleChange, the add/remove
  helpers, validateForm, handleSubmit and filteredSuggestions) keeps its
  behaviour. This stage replaces the local
  gradient/gray InputField component and the ad-hoc blue-600 class strings with
  the shared Field/Input/Textarea/Select, Button, Card, Badge and PageContainer/
  PageHeader primitives and the index.css design tokens. No field, default,
  validation rule or endpoint was added, removed or renamed.
*/
const PostJobForm = () => {
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        location: '',
        jobType: '',
        applicationDeadline: '',
        jobStartDate: '',
        expectedEndDate: '',
        price: '',
        negotiable: 'no',
        applicationRequirements: {
            resume: 'not_needed',
            coverLetter: 'optional',
            portfolio: 'not_needed',
        },
        skillsRequired: [],
        requirements: [],
        responsibilities: [],
    });

    const [skillInput, setSkillInput] = useState('');
    const [requirementInput, setRequirementInput] = useState('');
    const [responsibilityInput, setResponsibilityInput] = useState('');
    const [errors, setErrors] = useState({});
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const submitInFlightRef = useRef(false);
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    // Phase 5A of the data-fetching audit: the navbar's profile read is the
    // shared identity query (useUserQuery.js) instead of a private fetchUser
    // effect. The page still waits for the document before rendering (the
    // `loading` gate below is now the query's first-load status), and a failed
    // or absent document still leaves the navbar with an empty user object.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);
    const user = userQuery.data || {};

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value,
        }));
        if (errors[name]) {
            setErrors(prev => ({ ...prev, [name]: '' }));
        }
    };

    // STAGE 12.13. The application requirements are a nested map, so they need
    // their own handler; the flat handleChange above would replace the whole
    // object with a string. Each select names its key (resume/coverLetter/
    // portfolio) and carries one of the three levels jobService accepts.
    const handleRequirementChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            applicationRequirements: {
                ...prev.applicationRequirements,
                [name]: value,
            },
        }));
    };

    const addSkill = (skill) => {
        if (skill && !formData.skillsRequired.includes(skill)) {
            setFormData(prev => ({
                ...prev,
                skillsRequired: [...prev.skillsRequired, skill],
            }));
        }
        setSkillInput('');
    };

    const removeSkill = (skill) => {
        setFormData(prev => ({
            ...prev,
            skillsRequired: prev.skillsRequired.filter(s => s !== skill),
        }));
    };

    const addRequirement = () => {
        if (requirementInput.trim() && !formData.requirements.includes(requirementInput.trim())) {
            setFormData(prev => ({
                ...prev,
                requirements: [...prev.requirements, requirementInput.trim()],
            }));
            setRequirementInput('');
        }
    };

    const removeRequirement = (requirement) => {
        setFormData(prev => ({
            ...prev,
            requirements: prev.requirements.filter(r => r !== requirement),
        }));
    };

    const addResponsibility = () => {
        if (responsibilityInput.trim() && !formData.responsibilities.includes(responsibilityInput.trim())) {
            setFormData(prev => ({
                ...prev,
                responsibilities: [...prev.responsibilities, responsibilityInput.trim()],
            }));
            setResponsibilityInput('');
        }
    };

    const removeResponsibility = (responsibility) => {
        setFormData(prev => ({
            ...prev,
            responsibilities: prev.responsibilities.filter(r => r !== responsibility),
        }));
    };

    const validateForm = () => {
        const newErrors = {};
        if (!formData.title.trim()) newErrors.title = 'Job title is required';
        if (!formData.description.trim()) newErrors.description = 'Job description is required';
        if (!formData.location.trim()) newErrors.location = 'Location is required';
        if (!formData.jobType.trim()) newErrors.jobType = 'Job type is required';
        if (!formData.applicationDeadline) newErrors.applicationDeadline = 'Application deadline is required';
        if (!formData.jobStartDate) newErrors.jobStartDate = 'Start date is required';
        if (!formData.price) newErrors.price = 'Price is required';

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (submitInFlightRef.current) return;

        const authUser = auth.currentUser;

        if (!authUser) {
            setSubmitError('Your session has expired. Please sign in again to post this job.');
            return;
        }

        if (!validateForm()) return;

        submitInFlightRef.current = true;
        setIsSubmitting(true);
        setSubmitError('');

        try {
            await api.post('/jobs/create', {
                ...formData,
                postedBy: authUser.uid,
            });

            // Phase 4 of the data-fetching audit: a successful create writes one
            // job document, which changes the employer's posted-jobs list -- the
            // shared entry EmployerDashboard and MyJobs both observe. Nothing
            // else the employer caches is affected: the new job has no
            // applications (so the counts map simply has no key for it, reading
            // as 0) and no employment. The invalidation is awaited before the
            // navigation; no observer of this key is mounted on /post-job, so
            // nothing refetches here -- the mark makes the destination pages
            // revalidate on mount instead of painting the pre-post list.
            await queryClient.invalidateQueries({ queryKey: queryKeys.employerJobs(authUser.uid) });

            navigate("/dashboard");
        } catch (err) {
            console.error('Error posting job:', err);
            setSubmitError('The job could not be posted. Please try again.');
        } finally {
            submitInFlightRef.current = false;
            setIsSubmitting(false);
        }
    };

    const filteredSuggestions = skillInput.length > 0
        ? skillSuggestions.filter(s =>
            s.toLowerCase().includes(skillInput.toLowerCase()) &&
            !formData.skillsRequired.includes(s)
        ).slice(0, 6)
        : [];

    if (Boolean(uid) && userQuery.isPending) {
        return <PageLoader label="Loading…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="py-8">
                <div className="mx-auto max-w-3xl space-y-6">
                    <PageHeader
                        title="Post a New Job"
                        description="Fill in the details below to create your job posting."
                    />

                    {submitError && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">{submitError}</p>
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Job Details Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <Briefcase className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Job details
                            </h2>

                            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                                <Field id="title" label="Job title" required error={errors.title} className="sm:col-span-2">
                                    <Input
                                        id="title"
                                        type="text"
                                        name="title"
                                        placeholder="e.g. Senior React Developer"
                                        value={formData.title}
                                        onChange={handleChange}
                                    />
                                </Field>

                                <Field id="location" label="Location" required error={errors.location}>
                                    <Input
                                        id="location"
                                        type="text"
                                        name="location"
                                        placeholder="e.g. New York, NY or Remote"
                                        value={formData.location}
                                        onChange={handleChange}
                                    />
                                </Field>

                                <Field id="jobType" label="Job type" required error={errors.jobType}>
                                    <Select
                                        id="jobType"
                                        name="jobType"
                                        value={formData.jobType}
                                        onChange={handleChange}
                                    >
                                        <option value="">Select job type</option>
                                        <option value="Full-time">Full-time</option>
                                        <option value="Part-time">Part-time</option>
                                        <option value="Contract">Contract</option>
                                        <option value="Freelance">Freelance</option>
                                        <option value="Internship">Internship</option>
                                    </Select>
                                </Field>

                                <Field id="description" label="Job description" required error={errors.description} className="sm:col-span-2">
                                    <Textarea
                                        id="description"
                                        name="description"
                                        rows={6}
                                        placeholder="Describe the role, responsibilities, and requirements..."
                                        value={formData.description}
                                        onChange={handleChange}
                                    />
                                </Field>
                            </div>
                        </Card>

                        {/* Job Requirements Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <CheckSquare className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Job requirements
                            </h2>

                            <div className="mt-4 space-y-4">
                                <Field
                                    id="requirement-input"
                                    label="Add a requirement"
                                    hint="Press Enter or the add button to add it to the list."
                                >
                                    <div className="flex gap-2">
                                        <Input
                                            id="requirement-input"
                                            type="text"
                                            placeholder="e.g. Bachelor's degree in Computer Science"
                                            value={requirementInput}
                                            onChange={(e) => setRequirementInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    addRequirement();
                                                }
                                            }}
                                        />
                                        <Button
                                            type="button"
                                            variant="primary"
                                            size="icon"
                                            aria-label="Add requirement"
                                            onClick={addRequirement}
                                        >
                                            <Plus className="h-5 w-5" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </Field>

                                {formData.requirements.length > 0 && (
                                    <div>
                                        <p className="text-sm font-medium text-foreground">Added requirements</p>
                                        <ul className="mt-2 space-y-2">
                                            {formData.requirements.map((requirement, index) => (
                                                <li
                                                    key={index}
                                                    className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-muted p-3"
                                                >
                                                    <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                                                        {requirement}
                                                    </span>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Remove ${requirement}`}
                                                        onClick={() => removeRequirement(requirement)}
                                                    >
                                                        <X className="h-4 w-4" aria-hidden="true" />
                                                    </Button>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </Card>

                        {/* Job Responsibilities Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <List className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Job responsibilities
                            </h2>

                            <div className="mt-4 space-y-4">
                                <Field
                                    id="responsibility-input"
                                    label="Add a responsibility"
                                    hint="Press Enter or the add button to add it to the list."
                                >
                                    <div className="flex gap-2">
                                        <Input
                                            id="responsibility-input"
                                            type="text"
                                            placeholder="e.g. Develop and maintain web applications"
                                            value={responsibilityInput}
                                            onChange={(e) => setResponsibilityInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    addResponsibility();
                                                }
                                            }}
                                        />
                                        <Button
                                            type="button"
                                            variant="primary"
                                            size="icon"
                                            aria-label="Add responsibility"
                                            onClick={addResponsibility}
                                        >
                                            <Plus className="h-5 w-5" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </Field>

                                {formData.responsibilities.length > 0 && (
                                    <div>
                                        <p className="text-sm font-medium text-foreground">Added responsibilities</p>
                                        <ul className="mt-2 space-y-2">
                                            {formData.responsibilities.map((responsibility, index) => (
                                                <li
                                                    key={index}
                                                    className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-muted p-3"
                                                >
                                                    <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                                                        {responsibility}
                                                    </span>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Remove ${responsibility}`}
                                                        onClick={() => removeResponsibility(responsibility)}
                                                    >
                                                        <X className="h-4 w-4" aria-hidden="true" />
                                                    </Button>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </Card>

                        {/* Timeline Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <Calendar className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Timeline
                            </h2>

                            <div className="mt-4 grid gap-5 sm:grid-cols-3">
                                <Field id="applicationDeadline" label="Application deadline" required error={errors.applicationDeadline}>
                                    <Input
                                        id="applicationDeadline"
                                        type="date"
                                        name="applicationDeadline"
                                        value={formData.applicationDeadline}
                                        onChange={handleChange}
                                    />
                                </Field>

                                <Field id="jobStartDate" label="Start date" required error={errors.jobStartDate}>
                                    <Input
                                        id="jobStartDate"
                                        type="date"
                                        name="jobStartDate"
                                        value={formData.jobStartDate}
                                        onChange={handleChange}
                                    />
                                </Field>

                                <Field id="expectedEndDate" label="Expected end date" error={errors.expectedEndDate}>
                                    <Input
                                        id="expectedEndDate"
                                        type="date"
                                        name="expectedEndDate"
                                        value={formData.expectedEndDate}
                                        onChange={handleChange}
                                    />
                                </Field>
                            </div>
                        </Card>

                        {/* Compensation Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <DollarSign className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Compensation
                            </h2>

                            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                                <Field id="price" label="Fixed price" required error={errors.price}>
                                    <Input
                                        id="price"
                                        type="number"
                                        name="price"
                                        placeholder="5000"
                                        value={formData.price}
                                        onChange={handleChange}
                                    />
                                </Field>

                                <Field id="negotiable" label="Price negotiability">
                                    <Select
                                        id="negotiable"
                                        name="negotiable"
                                        value={formData.negotiable}
                                        onChange={handleChange}
                                    >
                                        <option value="no">Fixed Price</option>
                                        <option value="yes">Negotiable</option>
                                    </Select>
                                </Field>
                            </div>
                        </Card>

                        {/* Application requirements Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <CheckSquare className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Application requirements
                            </h2>
                            <p className="mt-1 text-sm text-foreground-muted">
                                Choose what applicants must provide with their application.
                                "Required" blocks an application that omits it.
                            </p>

                            <div className="mt-4 grid gap-5 sm:grid-cols-3">
                                <Field id="req-resume" label="Resume">
                                    <Select
                                        id="req-resume"
                                        name="resume"
                                        value={formData.applicationRequirements.resume}
                                        onChange={handleRequirementChange}
                                    >
                                        <option value="not_needed">Not needed</option>
                                        <option value="optional">Optional</option>
                                        <option value="required">Required</option>
                                    </Select>
                                </Field>

                                <Field id="req-coverLetter" label="Cover letter">
                                    <Select
                                        id="req-coverLetter"
                                        name="coverLetter"
                                        value={formData.applicationRequirements.coverLetter}
                                        onChange={handleRequirementChange}
                                    >
                                        <option value="not_needed">Not needed</option>
                                        <option value="optional">Optional</option>
                                        <option value="required">Required</option>
                                    </Select>
                                </Field>

                                <Field id="req-portfolio" label="Portfolio">
                                    <Select
                                        id="req-portfolio"
                                        name="portfolio"
                                        value={formData.applicationRequirements.portfolio}
                                        onChange={handleRequirementChange}
                                    >
                                        <option value="not_needed">Not needed</option>
                                        <option value="optional">Optional</option>
                                        <option value="required">Required</option>
                                    </Select>
                                </Field>
                            </div>
                        </Card>

                        {/* Skills Section */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <Tags className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                Required skills
                            </h2>

                            <div className="mt-4 space-y-4">
                                <Field
                                    id="skill-input"
                                    label="Add a skill"
                                    hint="Type to search, then press Enter or the add button."
                                >
                                    <div className="flex gap-2">
                                        <Input
                                            id="skill-input"
                                            type="text"
                                            placeholder="Type to search skills..."
                                            value={skillInput}
                                            onChange={(e) => setSkillInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    if (skillInput.trim()) {
                                                        addSkill(skillInput.trim());
                                                    }
                                                }
                                            }}
                                        />
                                        <Button
                                            type="button"
                                            variant="primary"
                                            size="icon"
                                            aria-label="Add skill"
                                            onClick={() => {
                                                if (skillInput.trim()) {
                                                    addSkill(skillInput.trim());
                                                }
                                            }}
                                        >
                                            <Plus className="h-5 w-5" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </Field>

                                {/* Skill Suggestions */}
                                {filteredSuggestions.length > 0 && (
                                    <div className="rounded-md border border-border bg-surface-muted p-3">
                                        <p className="text-sm text-foreground-muted">Suggestions</p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            {filteredSuggestions.map(skill => (
                                                <button
                                                    key={skill}
                                                    type="button"
                                                    onClick={() => addSkill(skill)}
                                                    className="rounded-full border border-border bg-surface px-3 py-1 text-sm text-foreground transition-colors hover:bg-accent-subtle hover:text-accent-subtle-foreground"
                                                >
                                                    {skill}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Selected Skills */}
                                {formData.skillsRequired.length > 0 && (
                                    <div>
                                        <p className="text-sm font-medium text-foreground">Selected skills</p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            {formData.skillsRequired.map(skill => (
                                                <Badge key={skill} variant="primary" className="gap-1">
                                                    {skill}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeSkill(skill)}
                                                        aria-label={`Remove ${skill}`}
                                                        className="ml-0.5 rounded-full transition-colors hover:text-danger"
                                                    >
                                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                                    </button>
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </Card>

                        {/* Submit Button */}
                        <div className="pt-2">
                            <Button
                                type="submit"
                                size="lg"
                                className="w-full sm:w-auto"
                                disabled={isSubmitting}
                                aria-busy={isSubmitting}
                            >
                                {isSubmitting ? 'Posting…' : 'Post Job'}
                            </Button>
                        </div>
                    </form>
                </div>
            </PageContainer>
        </div>
    );
};

export default PostJobForm;
