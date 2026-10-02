
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Adjust path if needed
import api from '../api';
import JobSplitView from '../components/JobSplitView';
import ProfileSidebar from '../components/profileSideBar';
import { Search } from 'lucide-react';
import Navbar from '../components/Navbar';
import EmployerNavbar from '../components/EmployerNavbar';
const EmployeeDashboard = () => {
    // Stage 6R: isProfileComplete, isMobileMenuOpen and isDropdownOpen are gone.
    // All three were write-only state -- their setters were called, but the values
    // were never read anywhere, including the JSX, so none of them could influence
    // what this component renders. They are residue from when this page owned its
    // own navbar, profile dropdown and mobile menu, all of which were replaced by
    // the <EmployerNavbar/> this page now renders.
    //
    // The profile-completion redirect in the effect below does NOT depend on this
    // state: it tests the local profileStatus read straight from the API response.
    // That redirect is therefore unaffected and is preserved exactly as it was.
    const [jobs, setJobs] = useState([]);
    const [user, setUser] = useState({});
    const [applications, setApplications] = useState([]);
    const [activeSlide, setActiveSlide] = useState(0);
    const navigate = useNavigate();

    useEffect(() => {
        // Fetch user profile status
        const fetchProfileStatus = async () => {
            const currentUser = auth.currentUser;
            

            if (!currentUser) {
                navigate('/login');
                return;
            }

            try {
                console.log(currentUser);
                
                const [userRes, jobsRes, appsRes] = await Promise.all([
                    api.get(`/users/getUser/${currentUser.uid}`),
                    api.get('/jobs'),
                    api.get(`/applications/employee/${currentUser.uid}`)
                ]);

                setUser(userRes.data.user);
                const jobList = jobsRes.data.jobs || [];

                // Stage 5B: one count-only read replaces the per-job
                // GET /applications/job/:jobId fan-out that used to run purely to
                // read `.length`, which returned every applicant's details to this
                // employee-facing page. A failure here degrades to 0, exactly as the
                // old per-job failure path did, and deliberately does not fall
                // through to the profile-complete redirect below.
                let counts = {};
                try {
                    const countsRes = await api.get('/applications/counts');
                    counts = countsRes.data.counts || {};
                } catch (err) {
                    console.error('Error fetching application counts', err);
                }

                const jobsWithApplicants = jobList.map((job) => ({
                    ...job,
                    applicantCount: counts[job.id] || 0,
                }));

                setJobs(jobsWithApplicants);
                setApplications(appsRes.data.applications || []);

                // Stage 6R: this redirect is byte-for-byte unchanged and still driven
                // entirely by profileStatus from the API response. Only the trailing
                // setIsProfileComplete write was removed; the state it fed was never
                // read, so no rendered output can differ. The catch likewise still
                // only logs -- it never navigated, and now needs no setter.
                const profileStatus = userRes.data.user.profileComplete;
                if (!profileStatus) {
                    navigate('/complete-profile');
                }
            } catch (error) {
                console.error('Error fetching profile status:', error);
            }
        };

        fetchProfileStatus();

        // Carousel auto-slide
        const interval = setInterval(() => {
            setActiveSlide(prev => (prev + 1) % 3);
        }, 2500);

        return () => clearInterval(interval);
    }, [navigate]);

    // Stage 6R: applyToJob, handleLogout, toggleMobileMenu and toggleDropdown are
    // all removed. Each was defined and never referenced -- no JSX in this component
    // binds any of them, and the only elements that receive props are
    // <JobSplitView suggestedJobs={...} /> and <ProfileSidebar user={user} />, neither
    // of which is passed a callback. So all four were unreachable.
    //
    // handleLogout in particular was already correct code: it awaited auth.signOut()
    // before navigating, and did not navigate at all if sign-out failed. It was simply
    // never wired to anything. Sign-out for this page is owned by EmployerNavbar's
    // handleSignOut, which is wired to the "Sign out" button in that navbar's profile
    // dropdown, so removing this copy cannot affect whether an employee can log out.
    //
    // The lucide ChevronDown, Menu and X icons were removed alongside them, as they
    // existed only for the dropdown and mobile-menu UI this component no longer
    // renders, along with Link from react-router-dom. The auth import stays: it is
    // still read for auth.currentUser at the top of the effect.

    const filteredJobs = jobs.filter(job => {
        const hasApplied = applications.some(app => app.jobId === job.id);
        // Stage 5G: was `job.status === 'Filled'` against the title-cased value
        // the old hire flow wrote. The canonical spelling is lowercase 'filled';
        // documents that already hold 'Filled' are still recognised so a filled
        // job does not reappear in suggestions.
        const isFilled = job.status === 'filled' || job.status === 'Filled';
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
            {/* <Navbar/> */}
            <EmployerNavbar user={user} />

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