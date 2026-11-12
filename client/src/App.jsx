import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import queryClient from './queryClient';
import ProtectedRoute from './pages/ProtectedRoute';
import VerifyEmail from './pages/VerifyEmail';
import AuthPage from './pages/AuthPage';
import RoleBasedDashboard from './pages/RoleBasedDashboard';
import CompleteProfile from './pages/completeProfile';
import PostJobForm from './pages/PostJobForm';
import EditJobForm from './pages/EditJobForm';
import JobDetails from './pages/JobDetails';
import MyApplications from './pages/MyApplications';
import HiredJobs from './pages/HiredJobs';
import EmployeeJobTasks from './pages/EmployeeJobTasks';
import Profile from './pages/Profile';
import MyJobs from './pages/MyJobs';
import ViewJobApplications from './pages/ViewJobApplications';
import ManageEmployees from './pages/ManageEmployees';
import EmployeeWorkspace from './pages/EmployeeWorkspace';
import Conversations from './pages/Conversations';
import ConversationPage from './pages/ConversationPage';
import PaymentHistory from './pages/PaymentHistory';
import SessionCacheBoundary from './components/SessionCacheBoundary';
import ScrollToTop from './components/ScrollToTop';
import LandingPage from './pages/LandingPage';
import AboutPage from './pages/AboutPage';
import HowItWorksPage from './pages/HowItWorksPage';


function App() {
  return (
    // Phases 1-2 of the data-fetching audit: the shared TanStack Query client
    // (in-memory, per-tab; see queryClient.js for the defaults) wraps the whole
    // router so every page and the navbar observe the same cache -- notably the
    // one identity query useUserQuery provides. The provider sits OUTSIDE the
    // Router on purpose: it holds no routing state, and this way a route change
    // cannot remount it and drop the cache.
    <QueryClientProvider client={queryClient}>
      <SessionCacheBoundary>
        <Router>
          <ScrollToTop />
          <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
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
          {/* The caller's payment history. No role check: the same view serves
              employers and employees, and GET /payments/history derives ownership
              from the verified session rather than from this URL. */}
          <Route
            path="/payments"
            element={
              <ProtectedRoute>
                <PaymentHistory />
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
          {/* STAGE 10F: the per-job task workspace, and what a My Jobs card opens.
              The `:employmentId` is the EMPLOYMENT document id, not a job id, because
              one employee can hold two employments for the same job and the task list
              belongs to the hire rather than to the posting.

              The param is a request, not a grant. EmployeeJobTasks looks it up in the
              caller's own GET /employments/employee/:uid -- which the server already
              restricts to the caller with requireSelfParam -- and renders a not-found
              page without issuing any further request when it is not there. It also
              takes the jobId from that employment document rather than from the URL, and
              lists the caller's own tasks filtered to that employment. So a hand-edited
              id lands on "not one of your hired jobs" and can reach nothing.

              Same ProtectedRoute session gate as /employee/hired-jobs above, and the
              same absence of a role check: the page is the employee's, and the server's
              employment and task reads decide whose data it is.

              React Router ranks the static segment above the param, so this and
              /employee/hired-jobs are unambiguous in both directions and neither can
              shadow the other -- the same pairing Stage 10B noted for /messages and
              /messages/:conversationId. */}
          <Route
            path="/employee/hired-jobs/:employmentId"
            element={
              <ProtectedRoute>
                <EmployeeJobTasks />
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
          {/* STAGE 10H.3: the employer's employee list for one job, and what a job
              card's "Manage Employees" action opens when that job has one or more
              hires. It is the recruitment page's sibling, not its replacement:
              ViewJobApplications keeps the applicants, this shows the people actually
              hired, and a job can hire more than one.

              Same ProtectedRoute session gate and the same absence of a role check as
              the applications route above -- the server's requireJobOwner on
              GET /employments/job/:jobId is what refuses a caller who did not post
              the job, so this adds the session gate and nothing else.

              The `:jobTitle` is cosmetic -- the heading only. The page's data comes
              from `:jobId`, and it is the server, not this route, that decides whether
              the reader may see it. Both segments are the same shape as the
              applications route directly above, so the two are unambiguous: React
              Router ranks the static `applications` / `employees` segments apart, and
              neither can shadow the other. */}
          <Route
            path="/employer/jobs/:jobId/employees/:jobTitle"
            element={
              <ProtectedRoute>
                <ManageEmployees />
              </ProtectedRoute>
            }
          />
          {/* STAGE 10H.4.1: the employer's read-only workspace for ONE employment,
              opened from a row of Manage Employees. The path is deliberately
              `employments`, not `employees`: it differs from the route directly above
              at the fourth segment, so React Router ranks the two statics apart and
              neither can shadow the other. It carries `:employmentId` rather than an
              employee id because the employment -- not the person -- is what the page
              is about, and a person can hold more than one employment.

              Same ProtectedRoute session gate and the same absence of a role check as
              the two routes above: the server's requireEmploymentParty on
              GET /employments/:employmentId refuses anyone who is not a party to the
              employment, so this adds the session gate and nothing else. The page
              additionally checks the loaded employment's jobId against the path's
              jobId before requesting anything else. */}
          <Route
            path="/employer/jobs/:jobId/employments/:employmentId"
            element={
              <ProtectedRoute>
                <EmployeeWorkspace />
              </ProtectedRoute>
            }
          />

          {/* STAGE 8C: the conversation list. Same ProtectedRoute session gate as the
              other authenticated-intent routes, and deliberately no role check: the
              Stage 8B endpoint behind it takes the caller's uid from the verified token
              and admits either participant, so the page is genuinely the same view for an
              employer and an applicant and adds no authorization of its own.

              Takes no :uid in the path for the same reason /my-jobs does -- the reader is
              identified by the session, so ownership cannot be expressed in the URL.

              STAGE 10B: this route is RENAMED from /conversations to /messages, and the
              old path is gone rather than kept as an alias. Two routes rendering one page
              is the duplicate Stage 9F removed from /applications, and /conversations was
              a path the Stage 10B navbar no longer links to -- leaving it would have left
              a second, unlinked way in that nothing keeps in step with the first. */}
          <Route
            path="/messages"
            element={
              <ProtectedRoute>
                <Conversations />
              </ProtectedRoute>
            }
          />

          {/* STAGE 10B: the dedicated thread screen, and the reason /messages exists as
              more than a list. One conversation, one address: the navbar badge, an
              application card's Message button and an inbox row all arrive here, so the
              thread can be linked to, bookmarked and returned to with the back button.

              Same guard and the same absence of a role check as /messages above -- both
              render for either participant, because the Stage 8B conversation endpoints
              authorize on the conversation's own two uids.

              React Router ranks a static segment above a param, so this and /messages are
              unambiguous in both directions and neither can shadow the other. */}
          <Route
            path="/messages/:conversationId"
            element={
              <ProtectedRoute>
                <ConversationPage />
              </ProtectedRoute>
            }
          />

        </Routes>
      </Router>
      </SessionCacheBoundary>
    </QueryClientProvider>
  );
}

export default App;
