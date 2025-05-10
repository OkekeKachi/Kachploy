import React, { useState } from 'react';
import SignUp from './SignUp';
import Login from './Login';

const AuthPage = () => {
    const [isSignup, setisSignup] = useState(false);

    return (
        <div>            
            <div className="login-bg">
                {isSignup ? <SignUp setisSignup={setisSignup} /> : <Login setisSignup={setisSignup} />}
            </div>
        </div>
    );
};

export default AuthPage;
