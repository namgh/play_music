import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Router } from './ui/Router.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root 없음');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Router />
    </ErrorBoundary>
  </StrictMode>,
);
