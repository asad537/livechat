import { defineConfig } from 'vite';
import path from 'node:path';

// Builds the embeddable widget as a single self-contained IIFE: dist/widget.js
// (styles live in JS template strings injected into the widget's Shadow DOM,
// so no separate CSS file is emitted)
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: {
      '@livechat/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      name: 'LiveChatWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
