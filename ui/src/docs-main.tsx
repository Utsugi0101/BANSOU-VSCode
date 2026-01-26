import React from 'react';
import { createRoot } from 'react-dom/client';
import DocsApp from './DocsApp';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <DocsApp />
    </React.StrictMode>
  );
}
