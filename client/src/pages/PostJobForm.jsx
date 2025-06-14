import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import EmployerNavbar from '../components/EmployerNavbar';
import { Briefcase, MapPin, Clock, DollarSign, Calendar, Users, X, Plus, CheckSquare, List } from 'lucide-react';

// Mock skill suggestions - replace with your actual import
const skillSuggestions = [
    'JavaScript', 'React', 'Node.js', 'Python', 'TypeScript', 'HTML/CSS',
    'MongoDB', 'PostgreSQL', 'AWS', 'Docker', 'Git', 'GraphQL',
    'Vue.js', 'Angular', 'Express.js', 'Django', 'Flask', 'MySQL'
];

// Move InputField component outside to prevent re-creation
const InputField = ({ icon: Icon, label, name, type = 'text', placeholder, required = false, className = '', value, onChange, error }) => (
    <div className="space-y-2">
        <label className="flex items-center text-sm font-medium text-gray-700">
            <Icon className="w-4 h-4 mr-2 text-gray-500" />
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <input
            type={type}
            name={name}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            className={`w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${error ? 'border-red-500' : ''} ${className}`}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
);

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
        skillsRequired: [],
        requirements: [],
        responsibilities: [],
    });

    const [user, setUser] = useState({});
    const [skillInput, setSkillInput] = useState('');
    const [requirementInput, setRequirementInput] = useState('');
    const [responsibilityInput, setResponsibilityInput] = useState('');
    const [errors, setErrors] = useState({});
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    // Properly fetch user data once when component mounts
    useEffect(() => {
        const fetchUser = async () => {
            try {
                const authUser = auth.currentUser;
                if (authUser) {
                    console.log('Fetching user data for:', authUser.uid);
                    const res = await axios.get(`http://localhost:3000/users/getUser/${authUser.uid}`);
                    const userData = res.data.user;
                    setUser(userData);
                } else {
                    console.log('No authenticated user found');
                }
            } catch (error) {
                console.error('Error fetching user:', error);
            } finally {
                setLoading(false);
            }
        };

        const unsubscribe = auth.onAuthStateChanged((authUser) => {
            if (authUser) {
                fetchUser();
            } else {
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, []);

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
        const authUser = auth.currentUser;

        if (!authUser) {
            alert('You must be logged in');
            return;
        }

        if (!validateForm()) return;

        try {
            await axios.post('http://localhost:3000/jobs/create', {
                ...formData,
                postedBy: authUser.uid,
            });

            alert('Job posted successfully!');
            navigate("/dashboard");
        } catch (err) {
            console.error('Error posting job:', err);
            alert('Failed to post job');
        }
    };

    const filteredSuggestions = skillInput.length > 0
        ? skillSuggestions.filter(s =>
            s.toLowerCase().includes(skillInput.toLowerCase()) &&
            !formData.skillsRequired.includes(s)
        ).slice(0, 6)
        : [];

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">Loading...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50  ">
            <EmployerNavbar user={user} />
            <br /><br />    
            <div className="max-w-3xl mx-auto">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
                        <Briefcase className="w-8 h-8 text-blue-600" />
                    </div>
                    <h1 className="text-3xl font-bold text-gray-900 mb-2">Post a New Job</h1>
                    <p className="text-gray-600">Fill in the details below to create your job posting</p>
                </div>

                <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-lg overflow-hidden">
                    <div className="p-8 space-y-6">
                        {/* Job Details Section */}
                        <div className="border-b border-gray-200 pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4">Job Details</h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="md:col-span-2">
                                    <InputField
                                        icon={Briefcase}
                                        label="Job Title"
                                        name="title"
                                        placeholder="e.g. Senior React Developer"
                                        required
                                        value={formData.title}
                                        onChange={handleChange}
                                        error={errors.title}
                                    />
                                </div>
                                <InputField
                                    icon={MapPin}
                                    label="Location"
                                    name="location"
                                    placeholder="e.g. New York, NY or Remote"
                                    required
                                    value={formData.location}
                                    onChange={handleChange}
                                    error={errors.location}
                                />
                                <div className="space-y-2">
                                    <label className="flex items-center text-sm font-medium text-gray-700">
                                        <Users className="w-4 h-4 mr-2 text-gray-500" />
                                        Job Type
                                        <span className="text-red-500 ml-1">*</span>
                                    </label>
                                    <select
                                        name="jobType"
                                        value={formData.jobType}
                                        onChange={handleChange}
                                        className={`w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${errors.jobType ? 'border-red-500' : ''}`}
                                    >
                                        <option value="">Select job type</option>
                                        <option value="Full-time">Full-time</option>
                                        <option value="Part-time">Part-time</option>
                                        <option value="Contract">Contract</option>
                                        <option value="Freelance">Freelance</option>
                                        <option value="Internship">Internship</option>
                                    </select>
                                    {errors.jobType && <p className="text-sm text-red-600">{errors.jobType}</p>}
                                </div>
                            </div>
                            <div className="mt-6">
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Job Description
                                    <span className="text-red-500 ml-1">*</span>
                                </label>
                                <textarea
                                    name="description"
                                    value={formData.description}
                                    onChange={handleChange}
                                    placeholder="Describe the role, responsibilities, and requirements..."
                                    rows={6}
                                    className={`w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors resize-none ${errors.description ? 'border-red-500' : ''}`}
                                />
                                {errors.description && <p className="text-sm text-red-600">{errors.description}</p>}
                            </div>
                        </div>

                        {/* Job Requirements Section */}
                        <div className="border-b border-gray-200 pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                                <CheckSquare className="w-5 h-5 mr-2 text-gray-600" />
                                Job Requirements
                            </h2>
                            <div className="space-y-4">
                                <div className="flex gap-2">
                                    <input
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
                                        className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                                    />
                                    <button
                                        type="button"
                                        onClick={addRequirement}
                                        className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        <Plus className="w-5 h-5" />
                                    </button>
                                </div>

                                {formData.requirements.length > 0 && (
                                    <div>
                                        <p className="text-sm font-medium text-gray-700 mb-2">Added Requirements:</p>
                                        <div className="space-y-2">
                                            {formData.requirements.map((requirement, index) => (
                                                <div
                                                    key={index}
                                                    className="flex items-start justify-between p-3 bg-gray-50 rounded-lg border"
                                                >
                                                    <span className="text-sm text-gray-800 flex-1">{requirement}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeRequirement(requirement)}
                                                        className="ml-2 text-red-600 hover:text-red-800 flex-shrink-0"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Job Responsibilities Section */}
                        <div className="border-b border-gray-200 pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                                <List className="w-5 h-5 mr-2 text-gray-600" />
                                Job Responsibilities
                            </h2>
                            <div className="space-y-4">
                                <div className="flex gap-2">
                                    <input
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
                                        className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                                    />
                                    <button
                                        type="button"
                                        onClick={addResponsibility}
                                        className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        <Plus className="w-5 h-5" />
                                    </button>
                                </div>

                                {formData.responsibilities.length > 0 && (
                                    <div>
                                        <p className="text-sm font-medium text-gray-700 mb-2">Added Responsibilities:</p>
                                        <div className="space-y-2">
                                            {formData.responsibilities.map((responsibility, index) => (
                                                <div
                                                    key={index}
                                                    className="flex items-start justify-between p-3 bg-gray-50 rounded-lg border"
                                                >
                                                    <span className="text-sm text-gray-800 flex-1">{responsibility}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeResponsibility(responsibility)}
                                                        className="ml-2 text-red-600 hover:text-red-800 flex-shrink-0"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Timeline Section */}
                        <div className="border-b border-gray-200 pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4">Timeline</h2>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <InputField
                                    icon={Calendar}
                                    label="Application Deadline"
                                    name="applicationDeadline"
                                    type="date"
                                    required
                                    value={formData.applicationDeadline}
                                    onChange={handleChange}
                                    error={errors.applicationDeadline}
                                />
                                <InputField
                                    icon={Clock}
                                    label="Start Date"
                                    name="jobStartDate"
                                    type="date"
                                    required
                                    value={formData.jobStartDate}
                                    onChange={handleChange}
                                    error={errors.jobStartDate}
                                />
                                <InputField
                                    icon={Calendar}
                                    label="Expected End Date"
                                    name="expectedEndDate"
                                    type="date"
                                    value={formData.expectedEndDate}
                                    onChange={handleChange}
                                    error={errors.expectedEndDate}
                                />
                            </div>
                        </div>

                        {/* Compensation Section */}
                        <div className="border-b border-gray-200 pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4">Compensation</h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <InputField
                                    icon={DollarSign}
                                    label="Fixed Price"
                                    name="price"
                                    type="number"
                                    placeholder="5000"
                                    required
                                    value={formData.price}
                                    onChange={handleChange}
                                    error={errors.price}
                                />
                                <div className="space-y-2">
                                    <label className="block text-sm font-medium text-gray-700">
                                        Price Negotiability
                                    </label>
                                    <select
                                        name="negotiable"
                                        value={formData.negotiable}
                                        onChange={handleChange}
                                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                                    >
                                        <option value="no">Fixed Price</option>
                                        <option value="yes">Negotiable</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        {/* Skills Section */}
                        <div className="pb-6">
                            <h2 className="text-xl font-semibold text-gray-900 mb-4">Required Skills</h2>
                            <div className="space-y-4">
                                <div className="flex gap-2">
                                    <input
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
                                        className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (skillInput.trim()) {
                                                addSkill(skillInput.trim());
                                            }
                                        }}
                                        className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        <Plus className="w-5 h-5" />
                                    </button>
                                </div>

                                {/* Skill Suggestions */}
                                {filteredSuggestions.length > 0 && (
                                    <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                                        <p className="text-sm text-gray-600 mb-2">Suggestions:</p>
                                        <div className="flex flex-wrap gap-2">
                                            {filteredSuggestions.map(skill => (
                                                <button
                                                    key={skill}
                                                    type="button"
                                                    onClick={() => addSkill(skill)}
                                                    className="px-3 py-1 bg-white border border-gray-300 rounded-full text-sm hover:bg-blue-50 hover:border-blue-300 transition-colors"
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
                                        <p className="text-sm font-medium text-gray-700 mb-2">Selected Skills:</p>
                                        <div className="flex flex-wrap gap-2">
                                            {formData.skillsRequired.map(skill => (
                                                <span
                                                    key={skill}
                                                    className="inline-flex items-center px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm"
                                                >
                                                    {skill}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeSkill(skill)}
                                                        className="ml-2 text-blue-600 hover:text-blue-800"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Submit Button */}
                        <div className="pt-6">
                            <button
                                type="submit"
                                className="w-full bg-blue-600 text-white py-4 px-6 rounded-lg font-semibold hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
                            >
                                Post Job
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default PostJobForm;