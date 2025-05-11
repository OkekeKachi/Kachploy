import React from 'react';
import { Link } from 'react-router-dom';

const ProfileSidebar = ({ user }) => {
    return (
        <div className="card" style={{ borderRadius: "8px", backgroundColor: "#f8f8f8", boxShadow: "0 2px 10px rgba(0,0,0,0.1)" }}>
            <div className="card-content" style={{ padding: "16px" }}>
                {/* Profile Image and Name */}
                <div style={{ textAlign: "center", marginBottom: "10px" }}>
                    <img
                        src={user.profilePic || "https://via.placeholder.com/80"}
                        alt="Profile"
                        className="circle"
                        style={{ width: "80px", height: "80px", objectFit: "cover" }}
                    />
                    <h5 style={{ margin: "10px 0 0", fontSize: "18px", fontWeight: "bold" }}>
                        {user.fullName}
                    </h5>
                    <p style={{ margin: "5px 0", fontSize: "14px", color: "#555" }}>
                        {user.title || 'Full Stack Web Developer'}
                    </p>
                </div>

                {/* Profile Completion */}
                <div style={{ marginBottom: "15px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
                        <a href="/profile" style={{ color: "#3e6b8f", fontSize: "14px", textDecoration: "none" }}>
                            Complete your profile
                        </a>
                        <span style={{ color: "#3e6b8f", fontWeight: "bold" }}>100%</span>
                    </div>
                    <div style={{
                        height: "4px",
                        backgroundColor: "#e0e0e0",
                        borderRadius: "2px",
                        overflow: "hidden"
                    }}>
                        <div style={{
                            width: "100%",
                            height: "100%",
                            backgroundColor: "#3e6b8f"
                        }}></div>
                    </div>
                </div>

                {/* Promote with ads section */}
                <div className="card-section" style={{ marginBottom: "15px", borderBottom: "1px solid #eee", paddingBottom: "15px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <h6 style={{ margin: 0, fontSize: "16px", fontWeight: "bold" }}>Promote with ads</h6>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>expand_more</i>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "14px" }}>Availability badge</span>
                        <a href="#!" style={{ color: "#555" }}><i className="material-icons" style={{ fontSize: "18px" }}>edit</i></a>
                    </div>
                    <div style={{ fontSize: "13px", color: "#888", marginBottom: "12px" }}>Off</div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "14px" }}>Boost your profile</span>
                        <a href="#!" style={{ color: "#555" }}><i className="material-icons" style={{ fontSize: "18px" }}>edit</i></a>
                    </div>
                    <div style={{ fontSize: "13px", color: "#888" }}>Off</div>
                </div>

                {/* Networks section */}
                <div className="card-section" style={{ marginBottom: "15px", borderBottom: "1px solid #eee", paddingBottom: "15px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <h6 style={{ margin: 0, fontSize: "16px", fontWeight: "bold" }}>Networks: 820</h6>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>expand_more</i>
                    </div>

                    <a
                        href="/buy-Networks"
                        className="btn"
                        style={{
                            width: "100%",
                            backgroundColor: "white",
                            color: "#3e6b8f",
                            border: "1px solid #3e6b8f",
                            borderRadius: "25px",
                            textTransform: "none",
                            boxShadow: "none",
                            marginBottom: "10px"
                        }}
                    >
                        Buy Networks
                    </a>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                        <a href="/view-details" style={{ color: "#3e6b8f" }}>View details</a>
                        <span style={{ color: "#888" }}>|</span>
                        <a href="/free-networks" style={{ color: "#3e6b8f" }}>Free Networks</a>
                    </div>
                </div>

                {/* Preferences section */}
                <div className="card-section" style={{ marginBottom: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eee" }}>
                        <span style={{ fontSize: "16px", fontWeight: "medium" }}>Preferences</span>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>expand_more</i>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eee" }}>
                        <span style={{ fontSize: "16px", fontWeight: "medium" }}>Proposals</span>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>expand_more</i>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eee" }}>
                        <span style={{ fontSize: "16px", fontWeight: "medium" }}>Project Catalog</span>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>expand_more</i>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "left", paddingRight: "150px", marginTop: "40px", borderBottom: "1px solid #eee" }}>
                        <span style={{ fontSize: "16px", fontWeight: "medium" }}>Get Paid</span>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>account_balance_wallet</i>
                    </div><br />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "left", paddingRight: "130px", borderBottom: "1px solid #eee" }}>
                        <span style={{ fontSize: "16px", fontWeight: "medium" }}>Help Center</span>
                        <i className="material-icons" style={{ fontSize: "20px", color: "#555" }}>help</i>
                    </div>
                </div>
            </div><br /><br /><br />
        </div>
    );
};

export default ProfileSidebar;