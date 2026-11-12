import React, { useRef, useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { auth } from '../firebase';
import {
    Briefcase,
    CheckSquare,
    List,
    Calendar,
    DollarSign,
    Tags,
    Plus,
    X,
    Edit3,
    ArrowLeft,
    AlertCircle,
} from 'lucide-react';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { Field, Input, Textarea, Select } from '../components/ui/Field';
import queryKeys from '../queryKeys';

// Mock skill suggestions - replace with your actual import
const skillSuggestions = [
    'JavaScript', 'React', 'Node.js', 'Python', 'TypeScript', 'HTML/CSS',
    'MongoDB', 'PostgreSQL', 'AWS', 'Docker', 'Git', 'GraphQL',
    'Vue.js', 'Angular', 'Express.js', 'Django', 'Flask', 'MySQL'
];

// STAGE 12.13. The application-requirement levels and defaults, mirrored from
// jobService so this form loads and saves the same three keys the server reads.
// A job written before the field existed is read through this normaliser, so the
// selects always have a value and saving cannot silently drop the map.
const REQUIREMENT_LEVELS = ['not_needed', 'optional', 'required'];
const DEFAULT_APPLICATION_REQUIREMENTS = {
    resume: 'not_needed',
    coverLetter: 'optional',
    portfolio: 'not_needed',
};
const normalizeApplicationRequirements = (value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {};
    for (const key of Object.keys(DEFAULT_APPLICATION_REQUIREMENTS)) {
        normalized[key] = REQUIREMENT_LEVELS.includes(source[key])
            ? source[key]
            : DEFAULT_APPLICATION_REQUIREMENTS[key];
    }
    return normalized;
};

/*
  STAGE 11.5: presentation-only redesign.

  The fetchJobData effect (including the STAGE 5D negotiable handling and the
  startDate/endDate fallbacks), handleChange, the add/remove helpers, validateForm,
  handleSubmit (PUT /jobs/edit/:jobId) and the inline `error` state keep their
  behaviour. This stage only replaces the
  local gradient/gray InputField and blue-600 class strings with the shared
  Field/Input/Textarea/Select, Button, Card, Badge and PageContainer/PageHeader
  primitives and the index.css design tokens.

  The header copy and the Edit3 icon make it explicit that an existing posting is
  being edited rather than created. There is deliberately no AppNavbar here,
  because the pre-11.5 page had none and this stage does not add one.
*/
const EditJobForm = () => {
    const navigate = useNavigate();
    const { jobId } = useParams();
    const queryClient = useQueryClient();

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
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const submitInFlightRef = useRef(false);

    // Fetch the job data to pre-fill the form
    useEffect(() => {
        const fetchJobData = async () => {
            try {
                const response = await api.get(`/jobs/${jobId}`);
                const job = response.data.job;

                setFormData({
                    title: job.title || '',
                    description: job.description || '',
                    location: job.location || '',
                    jobType: job.jobType || '',
                    applicationDeadline: job.applicationDeadline || '',
                    jobStartDate: job.jobStartDate || job.startDate || '',
                    expectedEndDate: job.expectedEndDate || job.endDate || '',
                    price: job.price || '',
                    // STAGE 5D: `negotiable` is canonical. The old
                    // `|| (job.isNegotiable ? 'yes' : 'no')` fallback is gone --
                    // no write path ever persisted `isNegotiable`, so it could
                    // only ever have contributed noise. The `|| 'no'` default is
                    // kept for a document that predates the field.
                    negotiable: job.negotiable || 'no',
                    // STAGE 12.13: read through the normaliser so a job with no
                    // applicationRequirements (every job filed before the field)
                    // loads with the same defaults a new job starts from, and the
                    // selects always control a real value.
                    applicationRequirements: normalizeApplicationRequirements(job.applicationRequirements),
                    skillsRequired: job.skillsRequired || [],
                    requirements: job.requirements || [],
                    responsibilities: job.responsibilities || [],
                });
                setLoading(false);
            } catch (err) {
                console.error('Error fetching job data:', err);
                setError('Failed to fetch job details.');
                setLoading(false);
            }
        };

        fetchJobData();
    }, [jobId]);

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
        if (!validateForm()) return;

        submitInFlightRef.current = true;
        setIsSubmitting(true);
        setError('');

        try {
            const response = await api.put(`/jobs/edit/${jobId}`, formData);
            if (response.status === 200) {
                // Phase 4 of the data-fetching audit: the edit rewrites
                // job-document fields both employer lists render, so their
                // shared entry is invalidated before the navigation. Only the
                // jobs list is affected -- this form writes no application or
                // employment document. Awaiting is cheap here: no observer of
                // this key is mounted on /edit-job, so nothing refetches on
                // this page; the mark makes the destination revalidate.
                if (auth.currentUser) {
                    await queryClient.invalidateQueries({
                        queryKey: queryKeys.employerJobs(auth.currentUser.uid),
                    });
                }

                navigate('/dashboard');
            }
        } catch (err) {
            console.error('Error updating job:', err);
            setError('Failed to update job. Please try again later.');
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

    if (loading) {
        return <PageLoader label="Loading job details…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <PageContainer className="py-8">
                <div className="mx-auto max-w-3xl space-y-6">
                    <PageHeader
                        title={
                            <span className="flex items-center gap-2">
                                <Edit3 className="h-6 w-6 text-foreground-subtle" aria-hidden="true" />
                                Edit job posting
                            </span>
                        }
                        description="Update the details of this existing posting. Your changes replace the values currently saved."
                        actions={
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => navigate('/dashboard')}
                            >
                                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                                Back to dashboard
                            </Button>
                        }
                    />

                    {error && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
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

                        {/* Submit Buttons */}
                        <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                            <Button
                                type="button"
                                variant="secondary"
                                size="lg"
                                className="sm:flex-1"
                                onClick={() => navigate('/dashboard')}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                size="lg"
                                className="sm:flex-1"
                                disabled={isSubmitting}
                                aria-busy={isSubmitting}
                            >
                                {isSubmitting ? 'Updating…' : 'Update Job'}
                            </Button>
                        </div>
                    </form>
                </div>
            </PageContainer>
        </div>
    );
};

export default EditJobForm;
