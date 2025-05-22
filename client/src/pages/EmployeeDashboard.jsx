
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Adjust path if needed
import axios from 'axios';
import JobSplitView from '../components/JobSplitView';
import ProfileSidebar from '../components/profileSideBar';
import { ChevronDown, Search, Menu, X } from 'lucide-react';

const EmployeeDashboard = () => {
    const [isProfileComplete, setIsProfileComplete] = useState(true);
    const [jobs, setJobs] = useState([]);
    const [user, setUser] = useState({});
    const [applications, setApplications] = useState([]);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [activeSlide, setActiveSlide] = useState(0);
    const navigate = useNavigate();

    useEffect(() => {
        // Fetch user profile status
        const fetchProfileStatus = async () => {
            const currentUser = auth.currentUser;
            console.log(currentUser);

            if (!currentUser) {
                navigate('/login');
                return;
            }

            try {
                const [userRes, jobsRes, appsRes] = await Promise.all([
                    axios.get(`http://localhost:3000/users/getUser/${currentUser.uid}`),
                    axios.get('http://localhost:3000/jobs'),
                    axios.get(`http://localhost:3000/applications/employee/${currentUser.uid}`)
                ]);

                setUser(userRes.data.user);
                const jobList = jobsRes.data.jobs || [];
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
                setApplications(appsRes.data.applications || []);

                const profileStatus = userRes.data.user.profileComplete;
                if (!profileStatus) {
                    navigate('/complete-profile');
                }
                setIsProfileComplete(profileStatus);
            } catch (error) {
                console.error('Error fetching profile status:', error);
                setIsProfileComplete(false);
            }
        };

        fetchProfileStatus();

        // Carousel auto-slide
        const interval = setInterval(() => {
            setActiveSlide(prev => (prev + 1) % 3);
        }, 2500);

        return () => clearInterval(interval);
    }, [navigate]);

    const applyToJob = (jobId) => {
        navigate(`/jobs/${jobId}`);
    };

    const handleLogout = async () => {
        try {
            await auth.signOut();
            navigate('/login');
        } catch (error) {
            console.error('Logout error:', error);
        }
    };

    const toggleMobileMenu = () => {
        setIsMobileMenuOpen(prev => !prev);
    };

    const toggleDropdown = () => {
        setIsDropdownOpen(prev => !prev);
    };

    const filteredJobs = jobs.filter(job => {
        const hasApplied = applications.some(app => app.jobId === job.id);
        const isFilled = job.status === 'Filled';
        const currentDate = new Date();
        const applicationDeadline = new Date(job.applicationDeadline);
        const isDeadlinePassed = applicationDeadline < currentDate;

        return !hasApplied && !isFilled && !isDeadlinePassed;
    });

    const suggestedJobs = filteredJobs.filter(job =>
        job.skillsRequired?.some(skill => user.skills?.includes(skill))
    );

    const slides = [
        {
            bgColor: "bg-blue-600",
            title: "Upskill Now",
            content: "Enroll in relevant courses to boost your qualifications.",
            image: "/rocket.png"
        },
        {
            bgColor: "bg-indigo-900",
            title: `Welcome back, ${user.fullName || 'User'}!`,
            content: "Here are some job opportunities waiting for you.",
            image: "/learn.png"
        },
        {
            bgColor: "bg-blue-800",
            title: "Boost your profile",
            content: "Add more skills to increase your chances.",
            image: "/fly.png"
        }
    ];

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Top Navigation Bar */}
            <nav className="bg-gray shadow-sm">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between h-16">
                        {/* Left: Logo and Links */}
                        <div className="flex items-center">
                            <div className="flex-shrink-0 flex items-center">
                                <img src="./image.png" alt="Logo" className="h-5 w-5" />
                                <span className="ml-2 text-xl font-semibold">KachPloy</span>
                            </div>
                            <div className="hidden md:ml-6 md:flex md:space-x-4">
                                <Link to="/my-applications" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                    My Applications
                                </Link>
                                <Link to="/profile" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                    Profile
                                </Link>
                                <Link to="/my-jobs" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                    My Jobs
                                </Link>
                            </div>
                        </div>

                        {/* Center: Search */}
                        <div className="hidden md:flex items-center">
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Search className="h-4 w-4 text-gray-500" />
                                </div>
                                <input
                                    type="text"
                                    placeholder="Search for jobs"
                                    className="block w-80 pl-10 pr-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>
                        </div>

                        {/* Right: Profile */}
                        <div className="hidden md:flex items-center">
                            <div className="relative">
                                <button
                                    onClick={toggleDropdown}
                                    className="flex items-center space-x-2 focus:outline-none"
                                >
                                    {user.profilePic && (
                                        <img
                                            className="h-8 w-8 rounded-full object-cover"
                                            src={user.profilePic}
                                            alt="Profile"
                                        />
                                    )}
                                    <ChevronDown className="h-4 w-4 text-gray-600" />
                                </button>

                                {/* Dropdown Menu */}
                                {isDropdownOpen && (
                                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50">
                                        <Link to="/profile" className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                            Edit Profile
                                        </Link>
                                        <div className="border-t border-gray-100"></div>
                                        <button
                                            onClick={handleLogout}
                                            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                        >
                                            Logout
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Mobile menu button */}
                        <div className="flex items-center md:hidden">
                            <button
                                onClick={toggleMobileMenu}
                                className="inline-flex items-center justify-center p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 focus:outline-none"
                            >
                                {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Mobile menu */}
                {isMobileMenuOpen && (
                    <div className="md:hidden">
                        <div className="pt-2 pb-3 space-y-1">
                            <div className="px-4 py-3 border-b border-gray-200">
                                <div className="flex items-center space-x-3">
                                    {user.profilePic && (
                                        <img
                                            className="h-10 w-10 rounded-full object-cover"
                                            src={user.profilePic}
                                            alt="Profile"
                                        />
                                    )}
                                    <div>
                                        <div className="font-medium text-gray-800">{user.fullName || 'User'}</div>
                                        <div className="text-sm text-gray-500">{user.email || 'user@example.com'}</div>
                                    </div>
                                </div>
                            </div>
                            <Link to="/my-applications" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                                My Applications
                            </Link>
                            <Link to="/profile" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                                Profile
                            </Link>
                            <Link to="/my-jobs" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                                My Jobs
                            </Link>
                            <button
                                onClick={handleLogout}
                                className="w-full text-left block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100"
                            >
                                Logout
                            </button>
                        </div>
                        <div className="pt-4 pb-3 px-4">
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Search className="h-4 w-4 text-gray-500" />
                                </div>
                                <input
                                    type="text"
                                    placeholder="Search for jobs"
                                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>
                        </div>
                    </div>
                )}
            </nav>

            {/* Main Content */}
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 ">
                <div className="flex flex-col md:flex-row md:space-x-8 ">
                    {/* Left Column - Job Content */}
                    <div className="md:w-3/4 ">
                        {/* Carousel */}
                        <div className="hidden sm:block relative h-64 rounded-3xl overflow-hidden mb-6">
                            {slides.map((slide, index) => (
                                <div
                                    key={index}
                                    className={`absolute inset-0 flex items-center transition-opacity duration-500 ease-in-out ${index === activeSlide ? 'opacity-100' : 'opacity-0 pointer-events-none'
                                        } ${slide.bgColor}`}
                                >
                                    <div className="flex justify-between items-center w-full px-8">
                                        <div className="text-white w-1/2">
                                            <h5 className="text-xl font-bold mb-2">{slide.title}</h5>
                                            <p>{slide.content}</p>
                                        </div>
                                        <div className="w-1/2 text-right">
                                            <img src={slide.image} alt="Illustration" className="h-44 object-contain inline-block" />
                                        </div>
                                    </div>
                                </div>
                            ))}

                            {/* Carousel Indicators */}
                            <div className="absolute bottom-4 left-0 right-0 flex justify-center space-x-2">
                                {slides.map((_, index) => (
                                    <button
                                        key={index}
                                        onClick={() => setActiveSlide(index)}
                                        className={`h-2 w-2 rounded-full ${index === activeSlide ? 'bg-white' : 'bg-white/50'
                                            }`}
                                    ></button>
                                ))}
                            </div>
                        </div>

                        {/* Mobile Search */}
                        <div className="md:hidden mb-6">
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Search className="h-4 w-4 text-gray-500" />
                                </div>
                                <input
                                    type="text"
                                    placeholder="Search for jobs"
                                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>
                        </div>

                        <h2 className="text-2xl font-bold mb-6">Apply for Jobs</h2>

                        {/* JobSplitView Component */}
                        <JobSplitView suggestedJobs={suggestedJobs} />
                    </div>

                    {/* Right Column - Profile Sidebar */}
                    <div className="md:w-1/4 mt-8 md:mt-0">
                        <ProfileSidebar user={user} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EmployeeDashboard;