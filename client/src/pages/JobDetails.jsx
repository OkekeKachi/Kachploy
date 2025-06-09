import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { auth } from '../firebase';
import axios from 'axios';
import { MapPin, Briefcase, DollarSign, Clock, CheckCircle, AlertCircle, Building, Users, Calendar, Star, Send } from 'lucide-react';
import Navbar from '../components/Navbar';
import EmployerNavbar from '../components/EmployerNavbar';


const JobDetails = () => {
    const { jobId } = useParams();
    const [job, setJob] = useState(null);
    const [user, setUser] = useState(null);
    const [message, setMessage] = useState('');
    const [applied, setApplied] = useState(false);
    const [employeePrice, setEmployeePrice] = useState('');
    const [loading, setLoading] = useState(true);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchJobAndUser = async () => {
            const res = await axios.get(`http://localhost:3000/jobs/${jobId}`);
            const dbUser = await axios.get(`http://localhost:3000/users/getUser/${auth.currentUser.uid}`);
            setJob(res.data.job);
            setUser(dbUser.data.user);
        };
        fetchJobAndUser();

        console.log(auth.currentUser.uid);
        console.log(user);

        setLoading(false)
    }, [jobId]);

    const handleApply = async () => {
        if (!user) {
            setError('You must be logged in to apply for this job.');
            return;
        }

        if (!message.trim()) {
            setError('Please write a message to accompany your application.');
            return;
        }

        if (job.isNegotiable && !employeePrice) {
            setError('Please enter your proposed price for this negotiable job.');
            return;
        }

        if (job.isNegotiable && Number(employeePrice) <= 0) {
            setError('Please enter a valid price amount.');
            return;
        }

        setApplying(true);
        setError('');

        try {
            // Simulate API call
            await new Promise(resolve => setTimeout(resolve, 2000));

            await axios.post('http://localhost:3000/applications/apply', {
                jobId,
                proposal: job.proposals,
                employeeId: auth.currentUser.uid,
                fullName: user.fullName || 'Anonymous',
                message,
                employeePrice: job.isNegotiable ? employeePrice : null,  // Only send employeePrice if negotiable
                status: "pending"
            });

            setApplied(true);
        } catch (err) {
            setError('Failed to submit application. Please try again.');
            console.error('Application failed:', err);
        } finally {
            setApplying(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white flex items-center justify-center">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-blue-600 font-medium">Loading job details...</p>
                </div>
            </div>
        );
    }

    if (error && !job) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white flex items-center justify-center">
                <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
                    <div className="text-center">
                        <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
                        <h2 className="text-xl font-semibold text-gray-900 mb-2">Unable to Load Job</h2>
                        <p className="text-gray-600">{error}</p>
                        <button
                            onClick={() => window.location.reload()}
                            className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Try Again
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!job) return null;

    return (
        <div>
            {/* Use the extracted Navbar component */}
            {/* <Navbar user={user} /> */}
            <EmployerNavbar user={user}/>
            
            
            <div className="min-h-screen bg-gradient-to-br from-white-900 via-white-800 to-white-900">
                {/* Hero Section */}
                <div className="relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-blue-900 via-blue-800 to-indigo-900"></div>
                    <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
                        <div className="text-center lg:text-left">
                            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3">
                                            <Building className="w-8 h-8 text-white" />
                                        </div>
                                        <span className="text-blue-200 font-medium">{job.company}</span>
                                    </div>
                                    <h1 className="text-3xl lg:text:4xl font-bold text-white mb-6 leading-tight">
                                        {job.title}
                                    </h1>
                                    <div className="flex flex-wrap gap-6 text-blue-100 text-lg">
                                        <div className="flex items-center gap-2">
                                            <MapPin className="w-6 h-6" />
                                            <span>{job.location}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Briefcase className="w-6 h-6" />
                                            <span className="capitalize">{job.jobType}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Users className="w-6 h-6" />
                                            <span>{job.proposal} applicants</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Star className="w-6 h-6 fill-yellow-400 text-yellow-400" />
                                            <span>{job.rating} rating</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Price Card */}
                                <div className="lg:flex-shrink-0">
                                    <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 border border-white/20">
                                        <div className="text-center">
                                            <div className="flex items-center justify-center gap-2 mb-2">
                                                {/* <DollarSign className="w-8 h-8 text-green-400" /> */}
                                                <span className="text-4xl font-bold text-white"> <span className='text-green-400'>₦</span> {job.price?.toLocaleString()}</span>
                                            </div>
                                            {job.isNegotiable ? (
                                                <div className="flex items-center justify-center gap-2 text-green-300">
                                                    <CheckCircle className="w-5 h-5" />
                                                    <span className="font-medium">Negotiable</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center justify-center gap-2 text-blue-200">
                                                    <Clock className="w-5 h-5" />
                                                    <span className="font-medium">Fixed Price</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Content */}
                <div className="relative -mt-8">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="grid lg:grid-cols-3 gap-8">
                            {/* Left Content */}
                            <div className="lg:col-span-2 space-y-8">
                                {/* Job Description */}
                                <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                                    <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                                        <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                                            <Briefcase className="w-6 h-6 text-blue-600" />
                                        </div>
                                        Job Description
                                    </h2>
                                    <div className="prose prose-lg max-w-none">
                                        <p className="text-gray-700 leading-relaxed whitespace-pre-wrap text-lg">
                                            {job.description}
                                        </p>
                                    </div>
                                </div>

                                {/* Requirements & Benefits */}
                                <div className="grid md:grid-cols-2 gap-8">
                                    <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                                        <h3 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                                            <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                                                <CheckCircle className="w-5 h-5 text-red-600" />
                                            </div>
                                            Skills Required
                                        </h3>
                                        <ul className="space-y-3">
                                            {job.skillsRequired.map((req, index) => (
                                                <li key={index} className="flex items-start gap-3">
                                                    <div className="w-2 h-2 bg-blue-600 rounded-full mt-3 flex-shrink-0"></div>
                                                    <span className="text-gray-700 text-lg">{req}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>

                                    <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                                        <h3 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                                            <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                                                <Star className="w-5 h-5 text-green-600" />
                                            </div>
                                            Basic Requirements
                                        </h3>
                                        <ul className="space-y-3">
                                        {job.requirements.map((benefit, index) => (
                                            <li key={index} className="flex items-start gap-3">
                                                <div className="w-2 h-2 bg-green-600 rounded-full mt-3 flex-shrink-0"></div>
                                                <span className="text-gray-700 text-lg">{benefit}</span>
                                            </li>
                                        ))}
                                        </ul>
                                    </div>
                                    <div className="bg-white/95 col-span-2 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                                        <h3 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                                            <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                                                <Star className="w-5 h-5 text-green-600" />
                                            </div>
                                            Responsibilities
                                        </h3>
                                        <ul className="space-y-3">
                                            {job.responsibilities.map((benefit, index) => (
                                                <li key={index} className="flex items-start gap-3">
                                                    <div className="w-2 h-2 bg-green-600 rounded-full mt-3 flex-shrink-0"></div>
                                                    <span className="text-gray-700 text-lg">{benefit}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div><br />
                                </div>
                            </div>

                            {/* Application Sidebar */}
                            <div className="lg:col-span-1">
                                <div className="sticky top-8">
                                    <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                                        {applied ? (
                                            <div className="text-center">
                                                <div className="w-15 h-15 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                                                    <CheckCircle className="w-12 h-12 text-green-600" />
                                                </div>
                                                <h3 className="text-xl font-bold text-gray-900 mb-4">Application Submitted!</h3>
                                                <p className="text-gray-600 text-lg leading-relaxed">
                                                    Your application has been sent successfully. The employer will review it and get back to you soon.
                                                </p>
                                                <div className="mt-6 p-4 bg-blue-50 rounded-xl">
                                                    <p className="text-sm text-blue-700">
                                                        <Calendar className="w-4 h-4 inline mr-2" />
                                                        Applied on {new Date().toLocaleDateString()}
                                                    </p>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <h3 className="text-2xl font-bold text-gray-900 mb-8 flex items-center gap-3">
                                                    <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                                                        <Send className="w-5 h-5 text-blue-600" />
                                                    </div>
                                                    Apply Now
                                                </h3>

                                                {error && (
                                                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
                                                        <div className="flex items-center gap-3">
                                                            <AlertCircle className="w-6 h-6 text-red-500 flex-shrink-0" />
                                                            <p className="text-red-700 font-medium">{error}</p>
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="space-y-6">
                                                    {job.isNegotiable && (
                                                        <div>
                                                            <label className="block text-lg font-bold text-gray-900 mb-3">
                                                                Your Proposed Price *
                                                            </label>
                                                            <div className="relative">
                                                                <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-500 font-bold text-lg">₦</span>
                                                                <input
                                                                    type="number"
                                                                    value={employeePrice}
                                                                    onChange={(e) => setEmployeePrice(e.target.value)}
                                                                    placeholder="Enter your price"
                                                                    min="0"
                                                                    className="w-full pl-10 pr-4 py-4 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all duration-200 text-lg font-medium"
                                                                    required
                                                                />
                                                            </div>
                                                            <p className="text-sm text-gray-500 mt-2 bg-blue-50 p-3 rounded-lg">
                                                                💡 This job allows price negotiation. Enter your competitive rate.
                                                            </p>
                                                        </div>
                                                    )}

                                                    <div>
                                                        <label className="block text-lg font-bold text-gray-900 mb-3">
                                                            Cover Message *
                                                        </label>
                                                        <textarea
                                                            value={message}
                                                            onChange={(e) => setMessage(e.target.value)}
                                                            placeholder="Tell us why you're perfect for this role. Highlight your relevant experience and what makes you stand out..."
                                                            rows="6"
                                                            maxLength="500"
                                                            className="w-full px-4 py-4 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all duration-200 resize-none text-lg"
                                                            required
                                                        />
                                                        <div className="flex justify-between items-center mt-2">
                                                            <p className="text-sm text-gray-500">
                                                                {message.length}/500 characters
                                                            </p>
                                                            <div className={`w-24 h-2 rounded-full ${message.length > 400 ? 'bg-red-200' : 'bg-gray-200'}`}>
                                                                <div
                                                                    className={`h-full rounded-full transition-all duration-300 ${message.length > 400 ? 'bg-red-500' : 'bg-blue-500'
                                                                        }`}
                                                                    style={{ width: `${(message.length / 500) * 100}%` }}
                                                                ></div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <button
                                                        onClick={handleApply}
                                                        disabled={applying || !user}
                                                        className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold py-5 px-6 rounded-xl hover:from-blue-700 hover:to-indigo-700 focus:ring-4 focus:ring-blue-200 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 text-lg shadow-lg hover:shadow-xl transform hover:-translate-y-1"
                                                    >
                                                        {applying ? (
                                                            <>
                                                                <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                                                Submitting Application...
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Send className="w-6 h-6" />
                                                                Submit Application
                                                            </>
                                                        )}
                                                    </button>

                                                    {!user && (
                                                        <div className="text-center p-4 bg-yellow-50 rounded-xl border border-yellow-200">
                                                            <p className="text-yellow-800 font-medium">
                                                                🔐 You must be logged in to apply for jobs.
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default JobDetails;