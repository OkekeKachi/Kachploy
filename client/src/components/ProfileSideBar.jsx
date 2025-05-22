import React from 'react';
import { Link } from 'react-router-dom';

const ProfileSidebar = ({ user }) => {
    return (
        <div className="bg-gray-50 rounded-lg shadow-lg">
            <div className="p-4">
                {/* Profile Image and Name */}
                <div className="text-center mb-4">
                    <img
                        src={user.profilePic || "https://via.placeholder.com/80"}
                        alt="Profile"
                        className="w-20 h-20 rounded-full mx-auto object-cover"
                    />
                    <h1 className="mt-2 mb-0 font-bold">
                        {user.fullName}
                    </h1>
                    <p className="mt-1 mb-0 text-sm text-gray-600">
                        {user.title || 'Full Stack Web Developer'}
                    </p>
                </div>

                {/* Profile Completion */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1">
                        <a href="/profile" className="text-blue-700 text-sm no-underline hover:underline">
                            Complete your profile
                        </a>
                        <span className="text-blue-700 font-bold">100%</span>
                    </div>
                    <div className="h-1 bg-gray-300 rounded-sm overflow-hidden">
                        <div className="w-full h-full bg-blue-700"></div>
                    </div>
                </div>

                {/* Promote with ads section */}
                <div className="mb-4 border-b border-gray-200 pb-4">
                    <div className="flex justify-between items-center mb-2">
                        <h6 className="m-0 text-base font-bold">Promote with ads</h6>
                        <i className="material-icons text-xl text-gray-600">expand_more</i>
                    </div>

                    <div className="flex justify-between items-center mb-2">
                        <span className="text-sm">Availability badge</span>
                        <a href="#!" className="text-gray-600 hover:text-gray-800">
                            <i className="material-icons text-lg">edit</i>
                        </a>
                    </div>
                    <div className="text-xs text-gray-500 mb-3">Off</div>

                    <div className="flex justify-between items-center mb-2">
                        <span className="text-sm">Boost your profile</span>
                        <a href="#!" className="text-gray-600 hover:text-gray-800">
                            <i className="material-icons text-lg">edit</i>
                        </a>
                    </div>
                    <div className="text-xs text-gray-500">Off</div>
                </div>

                {/* Networks section */}
                <div className="mb-4 border-b border-gray-200 pb-4">
                    <div className="flex justify-between items-center mb-2">
                        <h6 className="m-0 text-base font-bold">Networks: 820</h6>
                        <i className="material-icons text-xl text-gray-600">expand_more</i>
                    </div>

                    <a
                        href="/buy-Networks"
                        className="block w-full bg-white text-blue-700 border border-blue-700 rounded-full text-center py-2 px-4 mb-2 hover:bg-blue-50 transition-colors"
                    >
                        Buy Networks
                    </a>

                    <div className="flex justify-between text-sm">
                        <a href="/view-details" className="text-blue-700 hover:underline">View details</a>
                        <span className="text-gray-500">|</span>
                        <a href="/free-networks" className="text-blue-700 hover:underline">Free Networks</a>
                    </div>
                </div>

                {/* Preferences section */}
                <div className="mb-2">
                    <div className="flex justify-between items-center py-2 border-b border-gray-200">
                        <span className="text-base font-medium">Preferences</span>
                        <i className="material-icons text-xl text-gray-600">expand_more</i>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-gray-200">
                        <span className="text-base font-medium">Proposals</span>
                        <i className="material-icons text-xl text-gray-600">expand_more</i>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-gray-200">
                        <span className="text-base font-medium">Project Catalog</span>
                        <i className="material-icons text-xl text-gray-600">expand_more</i>
                    </div>

                    <div className="flex items-center justify-between py-2 mt-10 border-b border-gray-200">
                        <span className="text-base font-medium">Get Paid</span>
                        <i className="material-icons text-xl text-gray-600">account_balance_wallet</i>
                    </div>

                    <div className="flex items-center justify-between py-2 border-b border-gray-200">
                        <span className="text-base font-medium">Help Center</span>
                        <i className="material-icons text-xl text-gray-600">help</i>
                    </div>
                </div>
            </div>
            <div className="pb-12"></div>
        </div>
    );
};

export default ProfileSidebar;