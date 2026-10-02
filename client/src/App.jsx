import React from 'react';
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
import HiredJobs from './pages/HiredJobs';
import Profile from './pages/Profile';
import MyJobs from './pages/MyJobs';
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
        {/* STAGE 6O: the five remaining authenticated-intent routes. None of them
            had a session gate, so an anonymous visitor reached the page shell and
            a console error instead of /login. Same guard as /dashboard; no role
            logic is added, because server-side authorization is unchanged.
            /login and /verify-email above stay public on purpose. */}
        <Route
          path="/complete-profile"
          element={
            <ProtectedRoute>
              <CompleteProfile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/post-job"
          element={
            <ProtectedRoute>
              <PostJobForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/edit-job/:jobId"
          element={
            <ProtectedRoute>
              <EditJobForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:jobId"
          element={
            <ProtectedRoute>
              <JobDetails />
            </ProtectedRoute>
          }
        />
        <Route
          path="/my-applications"
          element={
            <ProtectedRoute>
              <MyApplications />
            </ProtectedRoute>
          }
        />
        {/* STAGE 6D: the real destination for the two `/profile` links Navbar.jsx has
            always rendered, which matched no route before this. Same guard as
            /dashboard. The page reads the uid from the auth session and PUTs to
            /users/update/:uid, which is already restricted to the caller by
            requireSelfParam -- no authorization behaviour changes here. */}
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
        {/* STAGE 6E: the employer's own posted jobs. Takes no :uid -- the employer is
            read from the auth session -- so ownership cannot be expressed in the URL.
            GET /jobs/employer/:uid is independently restricted to the caller by
            requireSelfParam and filters `where('postedBy', '==', uid)`. */}
        <Route
          path="/my-jobs"
          element={
            <ProtectedRoute>
              <MyJobs />
            </ProtectedRoute>
          }
        />
        {/* STAGE 6C: the real destination for the "View Your Hired Jobs" call to
            action in MyApplications.jsx, which used to point at this path before
            any route matched it. ProtectedRoute is the same guard /dashboard uses,
            and the page takes no identifier -- the employee comes from the auth
            session -- while GET /tasks/employee/:uid independently 403s any uid
            that is not the caller's own. */}
        <Route
          path="/employee/hired-jobs"
          element={
            <ProtectedRoute>
              <HiredJobs />
            </ProtectedRoute>
          }
        />
        {/* STAGE 6L: this route had no session gate, so an anonymous visitor reached
            the applicant review page and saw an empty list plus a console error
            instead of being turned away. No data leaked -- requireJobOwner 403s
            the fetch -- but it did not match the pattern the pages added in
            Stages 6C/6D/6E use. Deliberately no role check: the server already
            refuses any caller who did not post the job, so this adds the session
            gate and nothing else.

            This was not the last such route. The other five authenticated-intent
            routes were closed in Stage 6O, above; only /login and /verify-email
            remain intentionally public. */}
        <Route
          path="/employer/jobs/:jobId/applications/:jobTitle"
          element={
            <ProtectedRoute>
              <ViewJobApplications />
            </ProtectedRoute>
          }
        />

      </Routes>
    </Router>
  );
}

export default App;
