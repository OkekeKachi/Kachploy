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
            <nav className="white z-depth-0" >
                <div className="nav-wrapper " style={{marginLeft:"100px", marginRight:"100px"}} >
                    {/* Right: Links & Profile */}
                    <ul id="nav-mobile" className="left hide-on-med-and-down">
                        <li>
                            <img src="./image.png" alt="Logo" className="logo" style={{width:"20px"}} />
                            <span className="logo-text" style={{fontSize:"20px"}}>KachPloy</span>                            
                        </li>
                        <li style={{ paddingLeft: "20px", marginTop:"3px" }} ><Link to="/my-applications" style={{ fontSize: "14px" }} className="black-text">My Applications</Link></li>
                        <li ><Link to="/profile" style={{ fontSize: "14px", marginTop: "3px" }} className="black-text">Profile</Link></li>
                        <li ><Link to="/my-jobs" style={{ fontSize: "14px", marginTop: "3px" }} className="black-text">My Jobs</Link></li>
                        
                    </ul>
                    
                    <ul id="nav-mobile" className="right hide-on-med-and-down" >                        
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
                    <form className='right'>
                        <div className="input-field center" style={{ padding: "14px" }} >
                            <input id="search" style={{ borderRadius: "10px", height:"30px", width: "350px", border: "1px rgb(91, 91, 91) solid" }}  type="search" placeholder="Search for jobs" required />
                            <label style={{ marginLeft: "18px", }} className="label-icon" htmlFor="search">
                                <i className="material-icons black-text" style={{ color: "black !important" }}>search</i>
                            </label>
                            <i className="material-icons">close</i>
                        </div>
                    </form>
                    {/* Mobile Menu Trigger */}
                    <a href="#" data-target="mobile-nav" className="sidenav-trigger">
                        <i className="material-icons black-text">menu</i>
                    </a>
                </div >
                {/* Dropdown Structure */}
                < ul id="dropdown1" className="dropdown-content" >
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
                        <form style={{ paddingLeft: "0px", marginRight: "180px"}}>
                            <div className="input-field center" >
                                <input id="search" style={{ height: "30px", borderRadius: "10px", paddingLeft: "50px", border: "1px rgb(91, 91, 91) solid" }}  type="search" placeholder="Search for jobs" required /> 
                                <label style={{marginTop:"6px"}} className="label-icon" htmlFor="search"><i className="material-icons">search</i></label>
                               
                            </div>
                        </form>
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