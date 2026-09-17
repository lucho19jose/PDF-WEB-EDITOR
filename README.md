# PDF Web Editor

A browser-based PDF editor built with Vue 3, Vite, Quasar, and PDF processing libraries. The project is aimed at editing PDF content in the browser with support for rendering, manipulation, OCR, and document workflows.

## Overview

This repository contains a web application for working with PDF files online. It includes a Vue frontend, router setup, and libraries for PDF rendering/editing and OCR-based document processing.

## Tech Stack

- Vue 3
- Vite
- Quasar
- Pinia
- TypeScript
- PDF.js
- MuPDF
- Tesseract.js
- ONNX Runtime
- OpenType.js
- `esm-potrace-wasm`

## Project Structure

- `src/` — application source code
- `public/` — static public assets
- `tools/` — project utilities and analysis scripts
- `index.html` — app entry point
- `vite.config.ts` — Vite configuration
- `package.json` — dependency and script configuration

## Scripts

```bash
npm install
npm run dev
npm run build
npm run preview
```

## Development

To run the app locally:

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal in your browser.

## Production Build

```bash
npm run build
npm run preview
```

## Notes

This project is configured as a browser-first PDF workflow application and includes several libraries designed for PDF parsing, rendering, and content manipulation. It is intended for visual editing and document-processing tasks.

## Repository

- GitHub: https://github.com/lucho19jose/PDF-WEB-EDITOR
