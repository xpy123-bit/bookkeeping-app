import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { seedCategories } from './db/db.ts';

// 首次启动时写入内置分类，之后每次启动是无副作用的空操作。
void seedCategories();

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
