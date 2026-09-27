// Vercel builds the serverless function from this file, but the application lives in
// src/ as CommonJS. This used to be a second, ESM copy of the whole Express wiring that
// imported "./routes/..." and "./controllers/..." from this directory, where no such
// files exist: every production build died with ERR_MODULE_NOT_FOUND before serving a
// request. The duplicated wiring also drifted from src/app.js, so fixes applied to one
// entrypoint never reached the other.
//
// Re-exporting the single real app removes the duplication and keeps the deployed
// behaviour identical to `npm start`.
require('dotenv').config();

module.exports = require('../src/app');
