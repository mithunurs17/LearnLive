# LearnLive — Learning Management System
MERN + Redux Toolkit + BullMQ/Redis + FFmpeg + CloudFront + LiveKit + Razorpay test mode.

## Prerequisites
- Node.js 20+, MongoDB, Redis, FFmpeg installed and on PATH
- AWS S3/CloudFront (optional until video processing is enabled)
- LiveKit project (optional for live rooms)
- Razorpay test keys (optional for checkout)

## Setup
1. Copy `server/.env.example` to `server/.env`; fill credentials.
2. Copy `client/.env.example` to `client/.env`.
3. `cd server && npm install && npm run dev`
4. In another terminal: `cd client && npm install && npm run dev`
5. Optional worker: `cd server && npm run worker`
6. Visit http://localhost:5173. Register an account. First admin: set `ALLOW_ADMIN_SIGNUP=true` temporarily and choose admin at signup, then disable it.

## Functional scope
Auth/roles, course publishing, course enrollment, lesson completion, quiz attempts/autograding, certificate PDFs, instructor analytics, Razorpay test orders, LiveKit room tokens, queued video processing scaffold and CloudFront delivery URL support.

## Video pipeline
POST `/api/videos/upload-url` creates a presigned S3 upload URL. Upload source video directly, then POST `/api/videos/process` with its S3 key. Worker runs FFmpeg HLS packaging and stores output in S3. Configure AWS variables. For local demos, instructors may use direct HTTPS lesson URLs.

## Security & production notes
Use HTTPS, set strong secrets, restrict CORS, enforce rate limits, use a managed MongoDB/Redis, configure S3 bucket policy/CloudFront OAC, review retention/consent and payment compliance. Demo signup role selection is gated for admin; do not expose admin signup in production. LiveKit and Razorpay features require credentials.

## Phase 2 — Course studio and video upload
Instructor course management, lessons, upload lifecycle, and publication controls are implemented in `server/src/courseRoutes.js` and `client/src/pages/Studio.jsx`. Setup and infrastructure requirements are in `docs/PHASE2-COURSE-STUDIO.md`.

Run the API, Redis, MongoDB, FFmpeg video worker, and Vite client separately. The video upload feature requires a configured S3 bucket, bucket CORS, and CloudFront output distribution. New courses are drafts and cannot publish until at least one lesson's HLS conversion completes.
