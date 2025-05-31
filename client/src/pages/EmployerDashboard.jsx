import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import axios from 'axios';
import { Plus, Users, MapPin, Calendar, DollarSign, Edit3, Trash2, Eye, Building2, Search, Filter, TrendingUp, Briefcase } from 'lucide-react';
import EmployerNavbar from '../components/EmployerNavbar';

const EmployerDashboard = () => {
    const [profilePic, setProfilePic] = useState('');
    const [name, setName] = useState('User');
    const [user, setUser] = useState({})
    const [jobs, setJobs] = useState([]);
    const [filteredJobs, setFilteredJobs] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [isLoading, setIsLoading] = useState(true);
    const navigate = useNavigate();


    useEffect(() => {
        const fetchProfileAndJobs = async () => {
            const user = auth.currentUser;
            if (!user) {
                navigate('/login');
                return;
            }

            try {
                // Fetch user info
                const res = await axios.get(`http://localhost:3000/users/getUser/${user.uid}`);
                const userData = res.data.user;
                setProfilePic(userData.profilePic);
                setName(userData.fullName);
                setUser(userData);

                if (!userData.profileComplete) {
                    navigate('/complete-profile');
                    return;
                }

                // Fetch posted jobs
                const jobsRes = await axios.get(`http://localhost:3000/jobs/employer/${user.uid}`);
                const jobList = jobsRes.data.jobs || [];

                // Add applicant count to each job
                const jobsWithApplicants = await Promise.all(
                    jobList.map(async (job) => {
                        try {
                            const appRes = await axios.get(`http://localhost:3000/applications/job/${job.id}`);
                            return {
                                ...job,
                                applicantCount: appRes.data.applications?.length || 0,
                            };
                        } catch (err) {
                            console.error(`Error fetching applications for job ${job.id}`, err);
                            return { ...job, applicantCount: 0 };
                        }
                    })
                );

                setJobs(jobsWithApplicants);
                setFilteredJobs(jobsWithApplicants);
                setIsLoading(false)
            } catch (err) {
                console.error('Error:', err);
            }
        };

        fetchProfileAndJobs();
    }, [navigate]);
    
    // // Mock data for demonstration
    // const mockJobs = [
    //     {
    //         id: 1,
    //         title: 'Senior React Developer',
    //         location: 'Lagos, Nigeria',
    //         jobType: 'Full-time',
    //         createdAt: new Date('2024-01-15'),
    //         price: 500000,
    //         status: 'open',
    //         applicantCount: 12,
    //         description: 'We are looking for an experienced React developer to join our growing team. The ideal candidate should have 3+ years of experience with React, Redux, and modern JavaScript frameworks.'
    //     },
    //     {
    //         id: 2,
    //         title: 'Marketing Manager',
    //         location: 'Abuja, FCT',
    //         jobType: 'Full-time',
    //         createdAt: new Date('2024-01-10'),
    //         price: 350000,
    //         status: 'open',
    //         applicantCount: 8,
    //         description: 'Seeking a creative marketing manager to develop and execute marketing strategies. Experience with digital marketing, social media, and brand management required.'
    //     },
    //     {
    //         id: 3,
    //         title: 'Graphic Designer',
    //         location: 'Remote',
    //         jobType: 'Contract',
    //         createdAt: new Date('2024-01-05'),
    //         price: 150000,
    //         status: 'closed',
    //         applicantCount: 25,
    //         description: 'Looking for a talented graphic designer to create visual content for our brand. Proficiency in Adobe Creative Suite and strong portfolio required.'
    //     },
    //     {
    //         id: 4,
    //         title: 'Data Analyst',
    //         location: 'Port Harcourt, Rivers',
    //         jobType: 'Part-time',
    //         createdAt: new Date('2024-01-20'),
    //         price: 200000,
    //         status: 'paused',
    //         applicantCount: 0,
    //         description: 'Seeking a detail-oriented data analyst to help us make data-driven decisions. Experience with SQL, Python, and data visualization tools preferred.'
    //     }
    // ];
    

    // useEffect(() => {
    //     // Simulate API call
    //     setTimeout(() => {
    //         setJobs(mockJobs);
    //         setFilteredJobs(mockJobs);
    //         setIsLoading(false);
    //     }, 1000);
    // }, []);

    // Filter jobs based on search and status
    useEffect(() => {
        let filtered = jobs;

        if (searchTerm) {
            filtered = filtered.filter(job =>
                job.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                job.location.toLowerCase().includes(searchTerm.toLowerCase())
            );
        }

        if (statusFilter !== 'all') {
            filtered = filtered.filter(job => job.status === statusFilter);
        }

        setFilteredJobs(filtered);        
    }, [jobs, searchTerm, statusFilter]);
    const handleDeleteJob = async (jobId) => {
        try {
            const response = await axios.delete(`http://localhost:3000/jobs/${jobId}`);
            if (response.status === 200) {
                const updatedJobs = jobs.filter(job => job.id !== jobId);
                setJobs(updatedJobs);
                setFilteredJobs(updatedJobs);
            } else {
                console.error('Failed to delete job');
            }
        } catch (err) {
            console.error('Error deleting job:', err);
        }
    };

    const handlePostJob = () => {
        navigate("/post-job")
    };

    const handleEditJob = (jobId) => {
        alert(`Redirecting to edit job ${jobId}...`);
    };

    const handleViewApplications = (jobId, jobTitle) => {
        alert(`Viewing applications for: ${jobTitle}`);
    };

    const getStatusBadge = (status) => {
        const baseClasses = "px-3 py-1 rounded-full text-xs font-semibold";
        switch (status) {
            case 'open':
                return `${baseClasses} bg-green-100 text-green-800`;
            case 'closed':
                return `${baseClasses} bg-red-100 text-red-800`;
            case 'paused':
                return `${baseClasses} bg-yellow-100 text-yellow-800`;
            default:
                return `${baseClasses} bg-gray-100 text-gray-800`;
        }
    };

    const totalJobs = jobs.length;
    const openJobs = jobs.filter(job => job.status === 'open').length;
    const totalApplicants = jobs.reduce((sum, job) => sum + job.applicantCount, 0);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center">
                <div className="flex flex-col items-center space-y-4">
                    {/* Main spinner */}
                    <div className="relative">
                        <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-200"></div>
                        <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-600 border-t-transparent absolute top-0 left-0"></div>
                    </div>

                    {/* Loading text */}
                    <div className="text-center">
                        <p className="text-gray-700 font-medium">Loading...</p>
                        <p className="text-gray-500 text-sm">Please wait while we get you going</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100">
            <EmployerNavbar user={user}/>
            {/* Header */}
            
            <div className="max-w-7xl mx-auto bg-gradient-to-br from-blue-600 to-indigo-900 shadow-sm border-b px-4 sm:px-6 lg:px-6 py-4 sm:py-6 rounded-b-lg">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
                        <div className="flex items-center space-x-3 sm:space-x-4">
                            {profilePic ? (
                                <div className="relative flex-shrink-0">
                                    <img
                                        src={profilePic}
                                        alt="Profile"
                                        className="w-12 h-12 sm:w-16 sm:h-16 rounded-full object-cover ring-4 ring-blue-50"
                                    />
                                    <div className="absolute -bottom-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 bg-green-500 rounded-full border-2 border-white"></div>
                                </div>
                            ) : (
                                <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-blue-400 to-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                                    <Building2 className="w-6 h-6 sm:w-8 sm:h-8 text-white" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <h1 className="text-lg sm:text-2xl font-bold text-white truncate">
                                    Welcome back, {name}
                                </h1>
                                <p className="text-sm sm:text-base text-blue-100 hidden sm:block">
                                    Manage your job postings and applications
                                </p>
                                <p className="text-xs text-blue-200 sm:hidden">
                                    Manage jobs & applications
                                </p>
                            </div>
                        </div>

                        <div className="flex justify-end sm:justify-start">
                            <button
                                onClick={handlePostJob}
                                className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-semibold flex items-center space-x-2 transition-all duration-200 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                            >
                                <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
                                <span className="text-sm sm:text-base">Post New Job</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-100 hover:shadow-xl transition-shadow duration-300">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-gray-600">Total Jobs</p>
                                <p className="text-3xl font-bold text-gray-900">{totalJobs}</p>
                            </div>
                            <div className="p-3 bg-blue-100 rounded-full">
                                <Briefcase className="w-6 h-6 text-blue-600" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-100 hover:shadow-xl transition-shadow duration-300">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-gray-600">Active Jobs</p>
                                <p className="text-3xl font-bold text-green-600">{openJobs}</p>
                            </div>
                            <div className="p-3 bg-green-100 rounded-full">
                                <TrendingUp className="w-6 h-6 text-green-600" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-100 hover:shadow-xl transition-shadow duration-300">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-gray-600">Total Applications</p>
                                <p className="text-3xl font-bold text-purple-600">{totalApplicants}</p>
                            </div>
                            <div className="p-3 bg-purple-100 rounded-full">
                                <Users className="w-6 h-6 text-purple-600" />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Search and Filter */}
                <div className="bg-white rounded-xl shadow-lg p-6 mb-8 border border-gray-100">
                    <div className="flex flex-col sm:flex-row gap-4">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                            <input
                                type="text"
                                placeholder="Search jobs by title or location..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all duration-200"
                            />
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="pl-10 pr-8 py-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none appearance-none bg-white min-w-[150px]"
                            >
                                <option value="all">All Status</option>
                                <option value="open">Open</option>
                                <option value="closed">Closed</option>
                                <option value="paused">Paused</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Jobs List */}
                <div className="space-y-6">
                    <h2 className="text-xl font-bold text-gray-900">Your Job Postings ({filteredJobs.length})</h2>

                    {filteredJobs.length === 0 ? (
                        <div className="bg-white rounded-xl shadow-lg p-12 text-center border border-gray-100">
                            <Briefcase className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                            <h3 className="text-lg font-semibold text-gray-900 mb-2">
                                {jobs.length === 0 ? "No jobs posted yet" : "No jobs match your filters"}
                            </h3>
                            <p className="text-gray-600 mb-6">
                                {jobs.length === 0
                                    ? "Start by posting your first job to attract talented candidates."
                                    : "Try adjusting your search or filter criteria."
                                }
                            </p>
                            {jobs.length === 0 && (
                                <button
                                    onClick={handlePostJob}
                                    className="inline-flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors duration-200"
                                >
                                    <Plus className="w-5 h-5" />
                                    <span>Post Your First Job</span>
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="grid gap-6">
                            {filteredJobs.map((job) => (
                                <div
                                    key={job.id}
                                    className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 hover:shadow-xl transition-all duration-200 hover:-translate-y-1"
                                >
                                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                                        <div className="flex-1">
                                            <div className="flex items-start justify-between mb-3">
                                                <h3 className="text-xl font-bold text-gray-900 mb-2">{job.title}</h3>
                                                <span className={getStatusBadge(job.status)}>
                                                    {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                                                </span>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                                                <div className="flex items-center text-gray-600">
                                                    <MapPin className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm">{job.location}</span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <Calendar className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm">{new Date(job.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <DollarSign className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm font-semibold">₦{job.price?.toLocaleString()}</span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <Users className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm">{job.applicantCount} applicant{job.applicantCount !== 1 ? 's' : ''}</span>
                                                </div>
                                            </div>

                                            <p className="text-gray-600 text-sm leading-relaxed mb-4">{job.description}</p>

                                            <div className="flex items-center space-x-2 text-xs text-gray-500">
                                                <span className="bg-gray-100 px-2 py-1 rounded-full">{job.jobType}</span>
                                            </div>
                                        </div>

                                        <div className="flex flex-row lg:flex-col gap-2 lg:min-w-[200px]">
                                            <button
                                                onClick={() => handleEditJob(job.id)}
                                                disabled={job.applicantCount > 0}
                                                className={`flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium transition-all duration-200 ${job.applicantCount > 0
                                                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                                        : 'bg-blue-50 text-blue-600 hover:bg-blue-100 hover:shadow-md'
                                                    }`}
                                            >
                                                <Edit3 className="w-4 h-4" />
                                                <span>Edit</span>
                                            </button>

                                            <button
                                                onClick={() => handleDeleteJob(job.id)}
                                                disabled={job.applicantCount > 0}
                                                className={`flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium transition-all duration-200 ${job.applicantCount > 0
                                                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                                        : 'bg-red-50 text-red-600 hover:bg-red-100 hover:shadow-md'
                                                    }`}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                <span>Delete</span>
                                            </button>

                                            {job.status === 'open' ? (
                                                <button
                                                    onClick={() => handleViewApplications(job.id, job.title)}
                                                    className="flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-lg font-medium hover:from-green-600 hover:to-green-700 transition-all duration-200 hover:shadow-md"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    <span>View Apps</span>
                                                </button>
                                            ) : (
                                                <button
                                                    disabled
                                                    className="flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 bg-gray-100 text-gray-400 rounded-lg font-medium cursor-not-allowed"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    <span>Closed</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EmployerDashboard;