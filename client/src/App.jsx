import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './pages/ProtectedRoute';
import VerifyEmail from './pages/VerifyEmail';
import AuthPage from './pages/AuthPage';
import Dashboard from './pages/dashboard';
import CompleteProfile from './pages/completeProfile';

function App() {
  return (
    <Router>
      <Routes>
        
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/login" element={<AuthPage/>}/>
        <Route
          path="/dashboard" element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="complete-profile" element={<CompleteProfile />} />
      </Routes>
    </Router>
  );
}

export default App;
