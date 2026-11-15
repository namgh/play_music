import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Router } from './ui/Router.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import { applyTheme, loadThemeState } from './ui/theme.ts';

// 첫 그림부터 고른 색으로 — 렌더 뒤에 바꾸면 잠깐 기본색이 번쩍인다
applyTheme(loadThemeState());

const root = document.getElementById('root');
if (!root) throw new Error('#root 없음');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Router />
    </ErrorBoundary>
  </StrictMode>,
);
