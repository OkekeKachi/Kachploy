
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const JobSplitView = ({ suggestedJobs }) => {
    const [selectedJob, setSelectedJob] = useState(null);
    const [activeTab, setActiveTab] = useState('best');
    const navigate = useNavigate();

    useEffect(() => {
        // Initialize job selection when jobs are loaded
        if (suggestedJobs.length > 0) {
            setSelectedJob(suggestedJobs[0]);
        }
    }, [suggestedJobs]);

    const handleTabClick = (tab) => {
        setActiveTab(tab);
    };

    const handleJobSelect = (job) => {
        setSelectedJob(job);
    };

    const handleSaveJob = (e, jobId) => {
        e.stopPropagation();
        // Implement save job functionality
        console.log('Saving job:', jobId);
    };

    const handleCloseJob = (e, jobId) => {
        e.stopPropagation();
        // Implement close/dismiss job functionality
        console.log('Closing job:', jobId);
    };

    const applyToJob = (jobId) => {
        navigate(`/jobs/${jobId}`);
    };

    if (suggestedJobs.length === 0) return <p>No suggested jobs available.</p>;

    return (
        <div className="job-split-view card" style={{ margin: '20px 0', borderRadius: '8px', border: "1px hsl(0, 9.20%, 76.70%) solid", overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', flexDirection: 'row', height: '100%', minHeight: '400px' }}>
                {/* Left Panel - Job List */}
                <div style={{ width: '50%', borderRight: '1px solid #e0e0e0', overflowY: 'auto', maxHeight: '600px' }}>
                    {/* Top Tabs */}
                    <div style={{ padding: '20px 20px 0', borderBottom: '1px solid #e0e0e0' }}>
                        <h5 style={{ margin: '0 0 15px', fontSize: '20px', fontWeight: '500' }}><strong>Jobs you might like</strong></h5>
                        <div style={{ display: 'flex', marginBottom: '10px' }}>
                            <button
                                className={`btn-flat ${activeTab === 'best' ? 'active' : ''}`}
                                onClick={() => handleTabClick('best')}
                                style={{
                                    border: '1px solid #e0e0e0',
                                    borderRadius: '20px',
                                    marginRight: '10px',
                                    backgroundColor: activeTab === 'best' ? '#fff' : 'transparent',
                                    color: 'black',
                                    fontSize: '12px',
                                    fontWeight: activeTab === 'best' ? '500' : '400',
                                    boxShadow: activeTab === 'best' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                                }}
                            >
                                Best Matches
                            </button>
                            <button
                                className={`btn-flat ${activeTab === 'recent' ? 'active' : ''}`}
                                onClick={() => handleTabClick('recent')}
                                style={{
                                    border: '1px solid #e0e0e0',
                                    borderRadius: '20px',
                                    marginRight: '10px',
                                    backgroundColor: activeTab === 'recent' ? '#fff' : 'transparent',
                                    color: 'black',
                                    fontSize: '12px',
                                    fontWeight: activeTab === 'recent' ? '500' : '400',
                                    boxShadow: activeTab === 'recent' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                                }}
                            >
                                Most Recent
                            </button>
                            <button
                                className={`btn-flat ${activeTab === 'saved' ? 'active' : ''}`}
                                onClick={() => handleTabClick('saved')}
                                style={{
                                    border: '1px solid #e0e0e0',
                                    borderRadius: '20px',
                                    backgroundColor: activeTab === 'saved' ? '#fff' : 'transparent',
                                    color: 'black',
                                    fontSize: '12px',
                                    fontWeight: activeTab === 'saved' ? '500' : '400',
                                    boxShadow: activeTab === 'saved' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                                }}
                            >
                                Saved Jobs
                            </button>
                        </div>
                    </div>

                    {/* Job List */}
                    <div>
                        {suggestedJobs.map((job, index) => (
                            <div
                                key={job.id || index}
                                className={`job-card ${selectedJob && selectedJob.id === job.id ? 'selected' : ''}`}
                                onClick={() => handleJobSelect(job)}
                                style={{
                                    padding: '20px',
                                    borderBottom: '1px solid #e0e0e0',
                                    backgroundColor: selectedJob && selectedJob.id === job.id ? '#f9f9f9' : 'white',
                                    position: 'relative',
                                    cursor: 'pointer'
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <h6 style={{ margin: '0 0 10px', fontWeight: '500', fontSize: '16px' }}>
                                      <strong>{job.title || "Need a Website Designer Urgently"}</strong>  
                                    </h6>
                                    <div style={{ display: 'flex' }}>
                                        <button
                                            className="btn-flat btn-floating"
                                            onClick={(e) => handleSaveJob(e, job.id)}
                                            style={{ minWidth: 'auto', padding: '0' }}
                                        >
                                            <i className="material-icons" style={{ color: '#9e9e9e' }}>favorite_border</i>
                                        </button>
                                        <button
                                            className="btn-flat btn-floating"
                                            onClick={(e) => handleCloseJob(e, job.id)}
                                            style={{ minWidth: 'auto', padding: '0' }}
                                        >
                                            <i className="material-icons" style={{ color: '#9e9e9e' }}>close</i>
                                        </button>
                                    </div>
                                </div>

                                <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                    <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>attach_money</i>
                                    <span style={{ color: '#757575', fontSize: '14px', marginRight: '15px' }}>
                                        Fixed: ${job.price || "25"} · {job.experienceLevel || "Intermediate"}
                                    </span>
                                </div>

                                <div style={{ marginBottom: '10px' }}>
                                    <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px', verticalAlign: 'middle' }}>description</i>
                                    <span style={{ color: '#757575', fontSize: '14px' }}>
                                        Proposals: {job.applicantCount || 0}
                                    </span>
                                </div>

                                <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                    <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>verified_user</i>
                                    <span style={{ color: '#757575', fontSize: '14px', display: 'flex', alignItems: 'center' }}>
                                        Payment verified <i className="material-icons tiny" style={{ fontSize: '16px', color: '#4CAF50', margin: '0 5px' }}>check_circle</i>
                                        <span style={{ margin: '0 5px' }}>·</span>
                                        <i className="material-icons tiny" style={{ fontSize: '16px', color: '#FFB400', marginRight: '2px' }}>star</i>
                                        {job.rating || "5"}
                                        <span style={{ margin: '0 5px' }}>·</span>
                                        ${job.spent || "44K"}+ spent
                                        <span style={{ margin: '0 5px' }}>·</span>
                                        {job.location || "United States"}
                                    </span>
                                </div>

                                <div style={{ marginTop: '12px' }}>
                                    {(job.skillsRequired || ["Figma", "UX & UI", "Landing Page"]).map((skill, i) => (
                                        <span
                                            key={i}
                                            style={{
                                                backgroundColor: 'rgba(79, 80, 88, 0.65)',
                                                padding: '4px 12px',
                                                borderRadius: '15px',
                                                marginRight: '8px',
                                                fontSize: '12px',
                                                color: 'white',
                                                display: 'inline-block',
                                                marginBottom: '8px'
                                            }}
                                        >
                                            {skill}
                                        </span>
                                    ))}
                                    {job.skills && job.skills.length > 3 && (
                                        <span
                                            style={{
                                                backgroundColor: '#f5f5f5',
                                                padding: '4px 12px',
                                                borderRadius: '15px',
                                                fontSize: '12px',
                                                color: '#616161'
                                            }}
                                        >
                                            +{job.skills.length - 3}
                                        </span>
                                    )}
                                </div>

                                <div style={{ marginTop: '12px', fontSize: '12px', color: '#9e9e9e' }}>
                                    Posted {job.posted || "17 minutes ago"}
                                </div>
                            </div>
                        ))}

                        
                        <div
                            className="job-card"
                            onClick={() => handleJobSelect({
                                id: 'sample2',
                                title: 'Design a Simple Mobile App Onboarding Flow for a Beauty Brand',
                                budget: '15',
                                experienceLevel: 'Entry level',
                                proposals: '20 to 50',
                                rating: '0',
                                spent: '5',
                                location: 'GBR',
                                skillsRequired: ['Figma', 'UX & UI', 'Mobile App Design', 'Web Design'],
                                posted: '2 hours ago'
                            })}
                            style={{
                                padding: '20px',
                                borderBottom: '1px solid #e0e0e0',
                                backgroundColor: 'white',
                                position: 'relative',
                                cursor: 'pointer'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <h6 style={{ margin: '0 0 10px', fontWeight: '500', fontSize: '16px' }}>
                                    Design a Simple Mobile App Onboarding Flow for a Beauty Brand
                                </h6>
                                <div style={{ display: 'flex' }}>
                                    <button
                                        className="btn-flat btn-floating"
                                        onClick={(e) => handleSaveJob(e, 'sample2')}
                                        style={{ minWidth: 'auto', padding: '0' }}
                                    >
                                        <i className="material-icons" style={{ color: '#9e9e9e' }}>favorite_border</i>
                                    </button>
                                    <button
                                        className="btn-flat btn-floating"
                                        onClick={(e) => handleCloseJob(e, 'sample2')}
                                        style={{ minWidth: 'auto', padding: '0' }}
                                    >
                                        <i className="material-icons" style={{ color: '#9e9e9e' }}>close</i>
                                    </button>
                                </div>
                            </div>

                            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>attach_money</i>
                                <span style={{ color: '#757575', fontSize: '14px', marginRight: '15px' }}>
                                    Fixed: $15 · Entry level
                                </span>
                            </div>

                            <div style={{ marginBottom: '10px' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px', verticalAlign: 'middle' }}>description</i>
                                <span style={{ color: '#757575', fontSize: '14px' }}>
                                    Proposals: 20 to 50
                                </span>
                            </div>

                            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>verified_user</i>
                                <span style={{ color: '#757575', fontSize: '14px', display: 'flex', alignItems: 'center' }}>
                                    Payment verified <i className="material-icons tiny" style={{ fontSize: '16px', color: '#4CAF50', margin: '0 5px' }}>check_circle</i>
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    <i className="material-icons tiny" style={{ fontSize: '16px', color: '#FFB400', marginRight: '2px' }}>star</i>
                                    0
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    $5 spent
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    GBR
                                </span>
                            </div>

                            <div style={{ marginTop: '12px' }}>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>Figma</span>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>UX & UI</span>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>Mobile App Design</span>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>+1</span>
                            </div>

                            <div style={{ marginTop: '12px', fontSize: '12px', color: '#9e9e9e' }}>
                                Posted 2 hours ago
                            </div>
                        </div>

                        {/* Third job example */}
                        <div
                            className="job-card"
                            onClick={() => handleJobSelect({
                                id: 'sample3',
                                title: 'Build responsive WordPress site with booking/payment functionality',
                                budget: '12',
                                experienceLevel: 'Entry level',
                                proposals: 'Less than 5',
                                payment: 'unverified',
                                rating: '0',
                                spent: '0',
                                location: 'Nigeria',
                                skillsRequired: ['WordPress', 'Responsive Design', 'Payment Integration'],
                                posted: '3 hours ago'
                            })}
                            style={{
                                padding: '20px',
                                borderBottom: '1px solid #e0e0e0',
                                backgroundColor: 'white',
                                position: 'relative',
                                cursor: 'pointer'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <h6 style={{ margin: '0 0 10px', fontWeight: '500', fontSize: '16px' }}>
                                    Build responsive WordPress site with booking/payment functionality
                                </h6>
                                <div style={{ display: 'flex' }}>
                                    <button
                                        className="btn-flat btn-floating"
                                        onClick={(e) => handleSaveJob(e, 'sample3')}
                                        style={{ minWidth: 'auto', padding: '0' }}
                                    >
                                        <i className="material-icons" style={{ color: '#9e9e9e' }}>favorite_border</i>
                                    </button>
                                    <button
                                        className="btn-flat btn-floating"
                                        onClick={(e) => handleCloseJob(e, 'sample3')}
                                        style={{ minWidth: 'auto', padding: '0' }}
                                    >
                                        <i className="material-icons" style={{ color: '#9e9e9e' }}>close</i>
                                    </button>
                                </div>
                            </div>

                            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>attach_money</i>
                                <span style={{ color: '#757575', fontSize: '14px', marginRight: '15px' }}>
                                    Fixed: $12 · Entry level
                                </span>
                            </div>

                            <div style={{ marginBottom: '10px' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px', verticalAlign: 'middle' }}>description</i>
                                <span style={{ color: '#757575', fontSize: '14px' }}>
                                    Proposals: Less than 5
                                </span>
                            </div>

                            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons tiny" style={{ fontSize: '16px', color: '#757575', marginRight: '5px' }}>verified_user</i>
                                <span style={{ color: '#757575', fontSize: '14px', display: 'flex', alignItems: 'center' }}>
                                    Payment unverified <i className="material-icons tiny" style={{ fontSize: '16px', color: '#9e9e9e', margin: '0 5px' }}>help</i>
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    <i className="material-icons tiny" style={{ fontSize: '16px', color: '#9e9e9e', marginRight: '2px' }}>star_border</i>
                                    0
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    $0 spent
                                    <span style={{ margin: '0 5px' }}>·</span>
                                    Nigeria
                                </span>
                            </div>

                            <div style={{ marginTop: '12px' }}>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>WordPress</span>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>Responsive Design</span>
                                <span style={{ backgroundColor: '#f5f5f5', padding: '4px 12px', borderRadius: '15px', marginRight: '8px', fontSize: '12px', color: '#616161', display: 'inline-block', marginBottom: '8px' }}>Payment Integration</span>
                            </div>

                            <div style={{ marginTop: '12px', fontSize: '12px', color: '#9e9e9e' }}>
                                Posted 3 hours ago
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Panel - Job Details */}
                <div style={{ width: '50%', padding: '20px', overflowY: 'auto', maxHeight: '600px' }}>
                    {selectedJob && (
                        <>
                            <div>
                                <h5>{selectedJob.title}</h5><br />
                                <span style={{display:"block", marginBottom: "20px" }}>posted 2 hours ago</span>
                                <span>{selectedJob.description}</span>
                            </div><br /><hr />
                            <div style={{marginTop:"20px", marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons" style={{ fontSize: '22px', color: '#757575', marginRight: '10px' }}>public</i>
                                <div>
                                    <div style={{ fontWeight: '500' }}>Nigeria</div>
                                    <div style={{ color: '#757575', fontSize: '14px' }}>Application is free with Kachploy</div>
                                </div>
                            </div>

                            <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons" style={{ fontSize: '22px', color: '#757575', marginRight: '10px' }}>attach_money</i>
                                <div>
                                    <div style={{ fontWeight: '500' }}>${selectedJob.price || "25.00"}</div>
                                    <div style={{ color: '#757575', fontSize: '14px' }}>Fixed-price</div>
                                </div>
                            </div>

                            <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
                                <i className="material-icons" style={{ fontSize: '22px', color: '#757575', marginRight: '10px' }}>stars</i>
                                <div>
                                    <div style={{ fontWeight: '500' }}>Intermediate</div>
                                    <div style={{ color: '#757575', fontSize: '14px' }}>I am looking for a mix of experience and value</div>
                                </div>
                            </div>

                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontWeight: '500', marginBottom: '10px' }}>Project Type: <span style={{ fontWeight: '400' }}>{selectedJob.jobType}</span></div>
                            </div>

                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontWeight: '500', marginBottom: '10px' }}>
                                    <br /><span style={{fontSize:"18px"}}>Skills and Expertise Needed</span>
                                </div>
                            
                                    <div style={{ marginTop: '12px' }}>
                                        {(selectedJob.skillsRequired).map((skill, i) => (
                                            <span
                                                key={i}
                                                style={{
                                                    backgroundColor: '#7D7D7D',
                                                    padding: '4px 12px',
                                                    borderRadius: '15px',
                                                    marginRight: '8px',
                                                    fontSize: '12px',
                                                    color: 'white',
                                                    display: 'inline-block',
                                                    marginBottom: '8px'
                                                }}
                                            >
                                                {skill}
                                            </span>
                                        ))}
                                        
                                </div>
                                <br /><br />
                                <span style={{ fontSize: "18px" }}>About the client</span>                                
                            </div>

                            <div style={{ marginTop: '30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <button className="btn-flat" style={{ minWidth: 'auto', padding: '0' }}>
                                        <i className="material-icons" style={{ color: '#757575', marginRight: '5px' }}>more_vert</i>
                                    </button>
                                    <button className="btn-flat" style={{ minWidth: 'auto', padding: '0' }}>
                                        <i className="material-icons" style={{ color: '#757575', marginRight: '5px' }}>share</i>
                                    </button>
                                </div>

                                <div>
                                    <button
                                        className="btn-flat"
                                        style={{
                                            border: '1px solid #4CAF50',
                                            borderRadius: '20px',
                                            color: '#4CAF50',
                                            marginRight: '10px',
                                            padding: '0 20px'
                                        }}
                                    >
                                        <i className="material-icons left" style={{ color: '#4CAF50' }}>favorite_border</i>
                                        Save job
                                    </button>

                                    <button
                                        className="btn"
                                        onClick={() => applyToJob(selectedJob.id)}
                                        style={{
                                            backgroundColor: '#3e6b8f',
                                            borderRadius: '20px',
                                            boxShadow: 'none',
                                            padding: '0 20px'
                                        }}
                                    >
                                        Apply 
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default JobSplitView;