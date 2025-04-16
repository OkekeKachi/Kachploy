import React, { useState } from 'react';
import SignUp from './SignUp';
import Login from './Login';

const AuthPage = () => {
    const [isSignup, setisSignup] = useState(true);

    return (
        <div>
            <div>
                <button onClick={() => setisSignup(true)}>Sign Up</button>
                <button onClick={() => setisSignup(false)}>Login</button>                
            </div>
            
            <div>
                {isSignup ? <SignUp/> : <Login/>}
            </div>
        </div>
    );
};

export default AuthPage;
