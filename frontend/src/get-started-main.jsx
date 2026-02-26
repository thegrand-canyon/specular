import React from 'react';
import ReactDOM from 'react-dom/client';
import GetStarted from './components/GetStarted';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GetStarted onComplete={(data) => {
      console.log('Agent created:', data);
      // Store in localStorage for later use
      localStorage.setItem('specular_agent', JSON.stringify(data));
    }} />
  </React.StrictMode>
);
