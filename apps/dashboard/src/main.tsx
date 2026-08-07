import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './state';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <AppProvider>
      <App />
    </AppProvider>
  </BrowserRouter>,
);
