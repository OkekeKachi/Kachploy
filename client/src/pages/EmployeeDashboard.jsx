import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Adjust path if needed
import axios from 'axios';
import M from 'materialize-css';
import JobSplitView from '../components/JobSplitView';
import ProfileSidebar from '../components/profileSideBar';

const EmployeeDashboard = () => {
    const [isProfileComplete, setIsProfileComplete] = useState(true);
    const [jobs, setJobs] = useState([]);
    const [user, setUser] = useState({});
    const [applications, setApplications] = useState([]);
    const navigate = useNavigate();

    useEffect(() => {
        // Initialize Materialize components
        M.AutoInit();

        const elemsDropdown = document.querySelectorAll('.dropdown-trigger');
        M.Dropdown.init(elemsDropdown, {
            constrainWidth: false,
            coverTrigger: false,
            alignment: 'right'
        });

        const elemsSidenav = document.querySelectorAll('.sidenav');
        M.Sidenav.init(elemsSidenav);

        const elems = document.querySelectorAll('.carousel');
        const instances = M.Carousel.init(elems, {
            indicators: true
        });

        // Auto-slide every 4 seconds
        const interval = setInterval(() => {
            if (instances[0]) {
                instances[0].next();
            }
        }, 2500);

        // Fetch user profile status
        const fetchProfileStatus = async () => {
            const currentUser = auth.currentUser;

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
                setJobs(jobsRes.data.jobs || []);
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

        // ✅ Combined cleanup
        return () => {
            clearInterval(interval);
            instances.forEach((instance) => instance.destroy?.());
        };
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

    return (
        <div>
            {/* Top Navigation Bar */}
            <nav className="white">
                <div className="nav-wrapper container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    {/* Left: Logo */}
                    <div className="logo-container brand-logo">
                        <img src="./image.png" alt="Logo" className="logo" />
                        <span className="logo-text">KachPloy</span>
                    </div>
                    {/* Center: Search Bar */}

                    <div className="search-container hide-on-med-and-down" style={{ flexGrow: 1, display: "flex", justifyContent: "center", marginLeft: "80px" }}>
                        <div className="input-field" style={{ width: "250px", position: "relative" }}>
                            <input
                                id="search"
                                type="search"
                                required
                                placeholder="Search for Jobs"
                                style={{
                                    height: "35px",
                                    fontSize: "14px",
                                    padding: "0 10px",
                                    border: "1px solid rgb(45, 59, 122)",
                                    borderRadius: "6px",
                                    boxShadow: "none",
                                    width: "100%",
                                    paddingLeft: "30px"
                                }}
                            />
                            <label className="label-icon" htmlFor="search" style={{
                                position: 'absolute',
                                left: '10px',
                                top: '42%',
                                transform: 'translateY(-50%)'
                            }}>
                                <i className="material-icons black-text" style={{ fontSize: "24px" }}>search</i>
                            </label>
                            <i className="material-icons" style={{
                                fontSize: "18px",
                                cursor: "pointer",
                                position: "absolute",
                                left: "250px",
                                top: "40%",
                                transform: "translateY(-50%)"
                            }}>close</i>
                        </div>
                    </div>

                    {/* Right: Links & Profile */}
                    <ul id="nav-mobile" className="right hide-on-med-and-down" style={{ display: "flex", alignItems: "center", gap: "20px", margin: 0 }}>
                        <li><Link to="/my-applications" className="black-text">My Applications</Link></li>
                        <li><Link to="/profile" className="black-text">Profile</Link></li>
                        <li><Link to="/my-jobs" className="black-text">My Jobs</Link></li>
                        <li>
                            <a className="dropdown-trigger black-text" href="#!" data-target="dropdown1" style={{ display: "flex", alignItems: "center" }}>
                                <img
                                    src={user.profilePic}
                                    alt="Profile"
                                    className="circle"
                                    style={{ width: "30px", height: "30px", objectFit: "cover", marginRight: "6px" }}
                                />
                                
                                <i className="material-icons right">arrow_drop_down</i>
                            </a>
                        </li>
                    </ul>

                    {/* Mobile Menu Trigger */}
                    <a href="#" data-target="mobile-nav" className="sidenav-trigger">
                        <i className="material-icons black-text">menu</i>
                    </a>
                </div>

                {/* Dropdown Structure */}
                <ul id="dropdown1" className="dropdown-content">
                    <li><Link to="/profile">Edit Profile</Link></li>
                    <li className="divider" tabIndex="-1"></li>
                    <li><a href="#!" onClick={handleLogout}>Logout</a></li>
                </ul>
            </nav>

            {/* Mobile Navigation */}
            <ul className="sidenav" id="mobile-nav">
                <li>
                    <div className="user-view">
                        <div className="background teal lighten-5"></div>
                        <a href="#user"><img className="circle" src={user.profilePic} alt="User" /></a>
                        <a href="#name"><span className="name black-text">{user.fullName || 'User'}</span></a>
                        <a href="#email"><span className="email black-text">{user.email || 'user@example.com'}</span></a>
                    </div>
                </li>
                <li><Link to="/my-applications">My Applications</Link></li>
                <li><Link to="/profile">Profile</Link></li>
                <li><div className="divider"></div></li>
                <li><a href="#!" onClick={handleLogout}>Logout</a></li>
            </ul>

            {/* Suggested Jobs Section */}
            <div style={{ margin: "30px 130px" }}>
                <div className="row">
                    {/* Left Column - Job Content */}
                    <div className="col l9">
                        <div className="carousel carousel-slider " style={{ height: "250px", borderTopLeftRadius: "30px", borderTopRightRadius: "30px", borderBottomLeftRadius: "30px", borderBottomRightRadius: "30px" }}>
                            <div className="carousel-item white-text" style={{ backgroundColor: "#0877b8", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px" }}>
                                <div style={{ flex: 1 }}>
                                    <h5>Upskill Now</h5>
                                    <p>Enroll in relevant courses to boost your qualifications.</p>
                                </div>
                                <div style={{ flex: 1, textAlign: "right" }}>
                                    <img src="/rocket.png" alt="Job Search" style={{ height: "180px", objectFit: "contain" }} />
                                </div>
                            </div>
                            <div className="carousel-item white-text" style={{ backgroundColor: "#38168a", display: "flex", alignItems: "center", padding: "20px" }} >
                                <div style={{ flex: 1 }}>
                                    <h5>Welcome back, {user.fullName}!</h5>
                                    <p>Here are some job opportunities waiting for you.</p>
                                </div>
                                <div style={{ flex: 1, textAlign: "right" }}>
                                    <img src="/learn.png" alt="Boost" style={{ height: "180px", objectFit: "contain" }} />
                                </div>
                            </div>

                            <div className="carousel-item white-text" style={{ backgroundColor: "#3e6b8f", display: "flex", alignItems: "center", padding: "20px" }}>
                                <div style={{ flex: 1 }}>
                                    <h5>Boost your profile</h5>
                                    <p>Add more skills to increase your chances.</p>
                                </div>
                                <div style={{ flex: 1, textAlign: "right" }}>
                                    <img src="/fly.png" alt="Upskill" style={{ height: "200px", objectFit: "contain" }} />                                
                                </div>
                            </div>
                        </div><br />
                        <h4><strong>Apply for Jobs</strong></h4>
                        <JobSplitView suggestedJobs={suggestedJobs} />
                    </div>

                    {/* Right Column - Profile Sidebar Component */}
                    <div className="col l3">
                        <ProfileSidebar user={user} />
                    </div>
                </div>
            </div>            
        </div>
    );
};

export default EmployeeDashboard;