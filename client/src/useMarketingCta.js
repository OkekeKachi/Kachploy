import { useNavigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from './firebase';

/*
  Shared destination logic for marketing CTAs. Signed-out visitors go to the
  existing auth page; signed-in visitors go to their role-aware dashboard. The
  dashboard itself decides which role view to render, so no role logic is added
  here.
*/
const useMarketingCta = () => {
  const navigate = useNavigate();
  const [authUser, authLoading] = useAuthState(auth);

  return () => {
    if (authLoading || !authUser) {
      navigate('/login');
      return;
    }
    navigate('/dashboard');
  };
};

export default useMarketingCta;
