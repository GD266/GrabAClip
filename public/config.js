// Backend endpoint used by the frontend.
//
// Leave this empty when the frontend and API are served from the same origin
// (local development, or the full app deployed from the Dockerfile).
//
// When the frontend is hosted separately (for example on Vercel) point this at
// the deployed backend origin, with no trailing slash and no /api suffix:
//
//   window.GAC_API_BASE = "https://grabaclip-api.onrender.com";
//
// On Vercel you can also set the GAC_API_BASE environment variable; the build
// script writes this file automatically. See DEPLOY.md.
window.GAC_API_BASE = "";
