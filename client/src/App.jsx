import React from 'react';
import 'materialize-css/dist/css/materialize.min.css';
import 'materialize-css/dist/js/materialize.min.js';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './pages/ProtectedRoute';
import VerifyEmail from './pages/VerifyEmail';
import AuthPage from './pages/AuthPage';
import RoleBasedDashboard from './pages/RoleBasedDashboard';
import CompleteProfile from './pages/CompleteProfile';
import PostJobForm from './pages/PostJobForm';
import EditJobForm from './pages/editJobForm';
import JobDetails from './pages/JobDetails';
import MyApplications from './pages/MyApplications';
import ViewJobApplications from './pages/ViewJobApplications';


function App() {
  return (
    <Router>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/login" element={<AuthPage />} />

        {/* Protected route for dashboards */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <RoleBasedDashboard />
            </ProtectedRoute>
          }
        />
        <Route path="/complete-profile" element={<CompleteProfile />} />
        <Route path="/post-job" element={<PostJobForm />} />
        <Route path="/edit-job/:jobId" element={<EditJobForm />} />
        <Route path="/jobs/:jobId" element={<JobDetails />} />
        <Route path="/my-applications" element={<MyApplications />} />
        <Route path="/employer/jobs/:jobId/applications/:jobTitle" element={<ViewJobApplications />} />

      </Routes>
    </Router>
  );
}

export default App;
