import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';

// Create a separate component
const SkeletonJobLoader = () => {
    return (
        <div style={{ marginLeft: "100px", marginRight: "100px", }}>
            <nav className="white z-depth-0" style={{ marginTop: "20px" }}>
                <div className="nav-wrapper" >
                    {/* Left Side: Logo and Navigation Links */}
                    <ul id="nav-mobile" className="left hide-on-med-and-down" style={{ marginTop: "20px" }}>
                        <li style={{ display: 'flex', alignItems: 'center' }}>
                            {/* Logo Skeleton */}
                            <div style={{
                                width: '20px',
                                height: '20px',
                                backgroundColor: '#e0e0e0',
                                marginRight: '10px',
                                animation: 'pulse 1.5s infinite'
                            }}></div>
                            <div style={{
                                width: '80px',
                                height: '20px',
                                backgroundColor: '#e0e0e0',
                                animation: 'pulse 1.5s infinite'
                            }}></div>
                        </li>

                        {/* Navigation Links Skeleton */}
                        {['My Applications', 'Profile', 'My Jobs'].map((link, index) => (
                            <li
                                key={link}
                                style={{
                                    paddingLeft: index === 0 ? "20px" : "0",
                                    marginTop: "3px",
                                    marginLeft: index > 0 ? '15px' : '0'
                                }}
                            >
                                <div style={{
                                    width: '100px',
                                    height: '14px',
                                    backgroundColor: '#e0e0e0',
                                    animation: 'pulse 1.5s infinite'
                                }}></div>
                            </li>
                        ))}
                    </ul>

                    {/* Right Side: Search and Profile */}
                    <div>
                        {/* Search Bar Skeleton */}


                        {/* Profile Dropdown Skeleton */}
                        <ul id="nav-mobile" className="right hide-on-med-and-down" >
                            <li>
                                <form className='right'>
                                    <div className="input-field center" style={{ padding: "14px" }}>
                                        <div style={{
                                            width: '350px',
                                            height: '30px',
                                            borderRadius: '10px',
                                            backgroundColor: '#e0e0e0',
                                            animation: 'pulse 1.5s infinite'
                                        }}></div>
                                    </div>
                                </form>
                            </li>
                            <li style={{ marginTop: "13px" }}>
                                <div style={{
                                    display: "flex",
                                    alignItems: "center"
                                }}>
                                    <div style={{
                                        width: '30px',
                                        height: '30px',
                                        borderRadius: '50%',
                                        backgroundColor: '#e0e0e0',
                                        marginRight: '6px',
                                        animation: 'pulse 1.5s infinite'
                                    }}></div>
                                    <div style={{
                                        width: '20px',
                                        height: '20px',
                                        backgroundColor: '#e0e0e0',
                                        animation: 'pulse 1.5s infinite'
                                    }}></div>
                                </div>
                            </li>
                        </ul>
                    </div>

                    {/* Mobile Menu Trigger Skeleton */}
                    <a href="#" data-target="mobile-nav" className="sidenav-trigger">
                        <div style={{
                            width: '24px',
                            height: '24px',
                            backgroundColor: '#e0e0e0',

                            animation: 'pulse 1.5s infinite'
                        }}></div>
                    </a>
                </div>

                <style jsx>{`
                @keyframes pulse {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }
            `}</style>
            </nav>
            <div className="row">
                <div className="col l8">
                    <div style={{

                        height: '250px',
                        marginTop: "30px",
                        marginLeft: "30px",
                        backgroundColor: '#e0e0e0',
                        borderRadius: "10px",
                        animation: 'pulse 1.5s infinite'
                    }}></div>
                    <div style={{
                        height: '30px',
                        marginTop: "30px",
                        marginLeft: "30px",
                        backgroundColor: '#e0e0e0',
                        borderRadius: "10px",
                        animation: 'pulse 1.5s infinite'
                    }}></div>

                    <div className="row">
                        <div className="col l6" style={{
                            height: '450px',
                            marginTop: "30px",
                            marginLeft: "40px",
                            width: "430px",
                            backgroundColor: '#e0e0e0',
                            borderTopLeftRadius: "10px",
                            borderBottomLeftRadius: "10px",
                            animation: 'pulse 1.5s infinite'
                        }}></div>
                        <div className="col l6" style={{
                            height: '450px',
                            marginTop: "30px",
                            marginLeft: "1px",
                            width: "430px",
                            backgroundColor: '#e0e0e0',
                            borderTopRightRadius: "10px",
                            borderBottomRightRadius: "10px",
                            animation: 'pulse 1.5s infinite'
                        }}></div>
                    </div>
                </div>
                <div className="col l4">
                    <div style={{
                        height: '200px',
                        marginTop: "30px",
                        backgroundColor: '#e0e0e0',
                        marginRight: '10px',
                        borderRadius: "10px",
                        animation: 'pulse 1.5s infinite'
                    }}>
                    </div>
                    <div style={{
                        height: '200px',
                        marginTop: "30px",
                        backgroundColor: '#e0e0e0',
                        marginRight: '10px',
                        borderRadius: "10px",
                        animation: 'pulse 1.5s infinite'
                    }}>
                    </div>
                    <div style={{
                        height: '200px',
                        marginTop: "30px",
                        backgroundColor: '#e0e0e0',
                        marginRight: '10px',
                        borderRadius: "10px",
                        animation: 'pulse 1.5s infinite'
                    }}>
                    </div>
                </div>
            </div>
        </div>
    );
};

const ProtectedRoute = ({ children }) => {
    const [user, loading] = useAuthState(auth);
    if (loading) return <SkeletonJobLoader />     
    if (!user) return <Navigate to="/login" />;

    return children;
};

export default ProtectedRoute;
