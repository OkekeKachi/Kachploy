import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const JobSplitView = ({ suggestedJobs }) => {
    const [selectedJob, setSelectedJob] = useState(null);
    const [activeTab, setActiveTab] = useState('best');
    const [clientInfo, setClientInfo] = useState({})
    const [isLoadingClient, setIsLoadingClient] = useState(false)
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

    useEffect(() => {
        if (selectedJob && selectedJob.postedBy) {
            setIsLoadingClient(true);

            axios.get(`http://localhost:3000/users/getUser/${selectedJob.postedBy}`)
                .then(response => {
                    setClientInfo(response.data.user);
                    console.log(response.data.user);
                })
                .catch(error => {
                    console.error('Error fetching client info:', error);
                })
                .finally(() => {
                    setIsLoadingClient(false);
                });
        } else {
            setClientInfo(null);
        }
    }, [selectedJob]);

    if (suggestedJobs.length === 0) return <p>No suggested jobs available.</p>;

    return (
        <div className="my-5 rounded-lg border border-gray-400 overflow-hidden shadow-lg">
            <div className="flex flex-row h-160 min-h-96">
                {/* Left Panel - Job List */}
                <div className="w-1/2 border-r border-gray-300 overflow-y-auto max-h-screen">
                    {/* Top Tabs */}
                    <div className="px-5 pt-5 pb-0 border-b border-gray-300">
                        <h1 className="m-0 mb-4 text-xl font-medium">Jobs you might like</h1>
                        <div className="flex mb-2">
                            <button
                                className={`border border-gray-300 rounded-full mr-2 px-4 py-2 text-xs w-24 ${activeTab === 'best'
                                        ? 'bg-white font-medium shadow-sm'
                                        : 'bg-transparent font-normal'
                                    } text-black`}
                                onClick={() => handleTabClick('best')}
                            >
                                Best Matches
                            </button>
                            <button
                                className={`border border-gray-300 rounded-full mr-2 px-4 py-2 text-xs w-24 ${activeTab === 'recent'
                                        ? 'bg-white font-medium shadow-sm'
                                        : 'bg-transparent font-normal'
                                    } text-black`}
                                onClick={() => handleTabClick('recent')}
                            >
                                Most Recent
                            </button>
                            <button
                                className={`border border-gray-300 rounded-full px-4 py-2 text-xs w-24 ${activeTab === 'saved'
                                        ? 'bg-white font-medium shadow-sm'
                                        : 'bg-transparent font-normal'
                                    } text-black`}
                                onClick={() => handleTabClick('saved')}
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
                                className={`p-5 border-b border-gray-300 relative cursor-pointer ${selectedJob && selectedJob.id === job.id ? 'bg-gray-50' : 'bg-white'
                                    }`}
                                onClick={() => handleJobSelect(job)}
                            >
                                <div className="flex justify-between items-start">
                                    <h6 className="m-0 mb-2 font-medium">
                                        {job.title || "Need a Website Designer Urgently"}
                                    </h6>
                                    <div className="flex">
                                        <button
                                            className="min-w-0 p-0 hover:bg-gray-100 rounded"
                                            onClick={(e) => handleSaveJob(e, job.id)}
                                        >
                                            <i className="material-icons text-gray-500">favorite_border</i>
                                        </button>
                                        <button
                                            className="min-w-0 p-0 hover:bg-gray-100 rounded ml-2"
                                            onClick={(e) => handleCloseJob(e, job.id)}
                                        >
                                            <i className="material-icons text-gray-500">close</i>
                                        </button>
                                    </div>
                                </div>

                                <div className="mb-2 flex items-center">
                                    <i className="material-icons text-base text-gray-600 mr-1">attach_money</i>
                                    <span className="text-gray-600 text-sm mr-4">
                                        Fixed: ${job.price || "25"} · {job.experienceLevel || "Intermediate"}
                                    </span>
                                </div>

                                <div className="mb-2">
                                    <i className="material-icons text-base text-gray-600 mr-1 align-middle">description</i>
                                    <span className="text-gray-600 text-sm">
                                        Proposals: {job.applicantCount || 0}
                                    </span>
                                </div>

                                <div className="mb-2 flex items-center">
                                    <i className="material-icons text-base text-gray-600 mr-1">verified_user</i>
                                    <span className="text-gray-600 text-sm flex items-center">
                                        Payment verified
                                        <i className="material-icons text-base text-green-500 mx-1">check_circle</i>
                                        <span className="mx-1">·</span>
                                        <i className="material-icons text-base text-yellow-500 mr-1">star</i>
                                        {job.rating || "5"}
                                        <span className="mx-1">·</span>
                                        ${job.spent || "44K"}+ spent
                                        <span className="mx-1">·</span>
                                        {job.location || "United States"}
                                    </span>
                                </div>

                                <div className="mt-3">
                                    {(job.skillsRequired || ["Figma", "UX & UI", "Landing Page"]).map((skill, i) => (
                                        <span
                                            key={i}
                                            className="bg-gray-700 text-white px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2"
                                        >
                                            {skill}
                                        </span>
                                    ))}
                                    {job.skills && job.skills.length > 3 && (
                                        <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs">
                                            +{job.skills.length - 3}
                                        </span>
                                    )}
                                </div>

                                <div className="mt-3 text-xs text-gray-500">
                                    Posted {job.posted || "17 minutes ago"}
                                </div>
                            </div>
                        ))}

                        {/* Sample Job 2 */}
                        <div
                            className="p-5 border-b border-gray-300 bg-white relative cursor-pointer hover:bg-gray-50"
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
                        >
                            <div className="flex justify-between items-start">
                                <h6 className="m-0 mb-2 font-medium text-base">
                                    Design a Simple Mobile App Onboarding Flow for a Beauty Brand
                                </h6>
                                <div className="flex">
                                    <button
                                        className="min-w-0 p-0 hover:bg-gray-100 rounded"
                                        onClick={(e) => handleSaveJob(e, 'sample2')}
                                    >
                                        <i className="material-icons text-gray-500">favorite_border</i>
                                    </button>
                                    <button
                                        className="min-w-0 p-0 hover:bg-gray-100 rounded ml-2"
                                        onClick={(e) => handleCloseJob(e, 'sample2')}
                                    >
                                        <i className="material-icons text-gray-500">close</i>
                                    </button>
                                </div>
                            </div>

                            <div className="mb-2 flex items-center">
                                <i className="material-icons text-base text-gray-600 mr-1">attach_money</i>
                                <span className="text-gray-600 text-sm mr-4">
                                    Fixed: $15 · Entry level
                                </span>
                            </div>

                            <div className="mb-2">
                                <i className="material-icons text-base text-gray-600 mr-1 align-middle">description</i>
                                <span className="text-gray-600 text-sm">
                                    Proposals: 20 to 50
                                </span>
                            </div>

                            <div className="mb-2 flex items-center">
                                <i className="material-icons text-base text-gray-600 mr-1">verified_user</i>
                                <span className="text-gray-600 text-sm flex items-center">
                                    Payment verified
                                    <i className="material-icons text-base text-green-500 mx-1">check_circle</i>
                                    <span className="mx-1">·</span>
                                    <i className="material-icons text-base text-yellow-500 mr-1">star</i>
                                    0
                                    <span className="mx-1">·</span>
                                    $5 spent
                                    <span className="mx-1">·</span>
                                    GBR
                                </span>
                            </div>

                            <div className="mt-3">
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">Figma</span>
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">UX & UI</span>
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">Mobile App Design</span>
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs inline-block mb-2">+1</span>
                            </div>

                            <div className="mt-3 text-xs text-gray-500">
                                Posted 2 hours ago
                            </div>
                        </div>

                        {/* Sample Job 3 */}
                        <div
                            className="p-5 border-b border-gray-300 bg-white relative cursor-pointer hover:bg-gray-50"
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
                        >
                            <div className="flex justify-between items-start">
                                <h6 className="m-0 mb-2 font-medium text-base">
                                    Build responsive WordPress site with booking/payment functionality
                                </h6>
                                <div className="flex">
                                    <button
                                        className="min-w-0 p-0 hover:bg-gray-100 rounded"
                                        onClick={(e) => handleSaveJob(e, 'sample3')}
                                    >
                                        <i className="material-icons text-gray-500">favorite_border</i>
                                    </button>
                                    <button
                                        className="min-w-0 p-0 hover:bg-gray-100 rounded ml-2"
                                        onClick={(e) => handleCloseJob(e, 'sample3')}
                                    >
                                        <i className="material-icons text-gray-500">close</i>
                                    </button>
                                </div>
                            </div>

                            <div className="mb-2 flex items-center">
                                <i className="material-icons text-base text-gray-600 mr-1">attach_money</i>
                                <span className="text-gray-600 text-sm mr-4">
                                    Fixed: $12 · Entry level
                                </span>
                            </div>

                            <div className="mb-2">
                                <i className="material-icons text-base text-gray-600 mr-1 align-middle">description</i>
                                <span className="text-gray-600 text-sm">
                                    Proposals: Less than 5
                                </span>
                            </div>

                            <div className="mb-2 flex items-center">
                                <i className="material-icons text-base text-gray-600 mr-1">verified_user</i>
                                <span className="text-gray-600 text-sm flex items-center">
                                    Payment unverified
                                    <i className="material-icons text-base text-gray-500 mx-1">help</i>
                                    <span className="mx-1">·</span>
                                    <i className="material-icons text-base text-gray-500 mr-1">star_border</i>
                                    0
                                    <span className="mx-1">·</span>
                                    $0 spent
                                    <span className="mx-1">·</span>
                                    Nigeria
                                </span>
                            </div>

                            <div className="mt-3">
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">WordPress</span>
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">Responsive Design</span>
                                <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2">Payment Integration</span>
                            </div>

                            <div className="mt-3 text-xs text-gray-500">
                                Posted 3 hours ago
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Panel - Job Details */}
                <div className="w-1/2 p-5 overflow-y-auto max-h-screen">
                    {selectedJob && (
                        <>
                            <div>
                                <h1 className="text-xl font-normal mb-4">{selectedJob.title}</h1>
                                <span className="block mb-5 text-gray-600">posted 2 hours ago</span>
                                <span>{selectedJob.description}</span>
                            </div>
                            <hr className="my-5" />

                            <div className="mt-5 mb-5 flex items-center">
                                <i className="material-icons text-2xl text-gray-600 mr-2">public</i>
                                <div>
                                    <div className="font-medium">Nigeria</div>
                                    <div className="text-gray-600 text-sm">Application is free with Kachploy</div>
                                </div>
                            </div>

                            <div className="mb-5 flex items-center">
                                <i className="material-icons text-2xl text-gray-600 mr-2">attach_money</i>
                                <div>
                                    <div className="font-medium">${selectedJob.price || "25.00"}</div>
                                    <div className="text-gray-600 text-sm">Fixed-price</div>
                                </div>
                            </div>

                            <div className="mb-5 flex items-center">
                                <i className="material-icons text-2xl text-gray-600 mr-2">stars</i>
                                <div>
                                    <div className="font-medium">Intermediate</div>
                                    <div className="text-gray-600 text-sm">I am looking for a mix of experience and value</div>
                                </div>
                            </div>

                            <div className="mb-5">
                                <div className="font-medium mb-2">Project Type: <span className="font-normal">{selectedJob.jobType}</span></div>
                            </div>

                            <div className="mb-5">
                                <div className="font-medium mb-2">
                                    <span className="text-lg">Skills and Expertise Needed</span>
                                </div>
                                <div className="mt-3">
                                    {(selectedJob.skillsRequired || []).map((skill, i) => (
                                        <span
                                            key={i}
                                            className="bg-gray-600 text-white px-3 py-1 rounded-full mr-2 text-xs inline-block mb-2"
                                        >
                                            {skill}
                                        </span>
                                    ))}
                                </div>

                                <hr className="my-8" />

                                <div>
                                    <span className="text-2xl font-medium">About the client</span>

                                    {isLoadingClient ? (
                                        <div className="mt-2">Loading client information...</div>
                                    ) : clientInfo ? (
                                        <div className="mt-4">
                                            <div className="flex items-center mb-2">
                                                {clientInfo.profilePic ? (
                                                    <img
                                                        src={clientInfo.profilePic}
                                                        alt="Client"
                                                        className="w-10 h-10 rounded-full mr-2"
                                                    />
                                                ) : (
                                                    <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mr-2">
                                                        <i className="material-icons">person</i>
                                                    </div>
                                                )}
                                                <div>
                                                    <div className="font-medium">{clientInfo.fullName || 'Anonymous'}</div>
                                                    <div className="text-gray-600 text-sm">{clientInfo.location || 'Unknown location'}</div>
                                                </div>
                                            </div>

                                            <div className="flex items-center mb-2">
                                                <i className="material-icons text-base text-gray-600 mr-1">access_time</i>
                                                <span className="text-gray-600 text-sm">
                                                    Member since {clientInfo.createdAt ? new Date(clientInfo.createdAt).toLocaleDateString() : 'Unknown'}
                                                </span>
                                            </div>

                                            {clientInfo.rating && (
                                                <div className="flex items-center mb-2">
                                                    <i className="material-icons text-base text-yellow-500 mr-1">star</i>
                                                    <span className="text-gray-600 text-sm">
                                                        {clientInfo.rating} of 5 stars ({clientInfo.reviewCount || 0} reviews)
                                                    </span>
                                                </div>
                                            )}

                                            {clientInfo.bio && (
                                                <div className="mt-2 text-sm">
                                                    {clientInfo.bio}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="mt-2 text-gray-600">Client information unavailable</div>
                                    )}
                                </div>
                            </div>

                            <div className="mt-8 flex justify-between items-center">
                                <div className="flex items-center">
                                    <button className="min-w-0 p-0 hover:bg-gray-100 rounded">
                                        <i className="material-icons text-gray-600 mr-1">more_vert</i>
                                    </button>
                                    <button className="min-w-0 p-0 hover:bg-gray-100 rounded ml-2">
                                        <i className="material-icons text-gray-600 mr-1">share</i>
                                    </button>
                                </div>

                                <div className="flex">
                                    <button className="border border-green-500 rounded-full text-green-500 mr-2 px-5 py-2 hover:bg-green-50 flex items-center">
                                        <i className="material-icons text-green-500 mr-1">favorite_border</i>
                                        Save job
                                    </button>

                                    <button
                                        className="bg-blue-800 text-white rounded-full px-5 py-2 hover:bg-blue-900"
                                        onClick={() => applyToJob(selectedJob.id)}
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