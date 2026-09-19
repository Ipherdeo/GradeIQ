# GradeIQ

GradeIQ is a smart CGPA calculator and academic planning tool for Nigerian university students. Track semesters, predict future performance, plan target grades, and get research-assisted course insights.

## Deploy to Vercel

Import this repository into Vercel, then add one provider configuration from `.env.example` under **Project Settings → Environment Variables**. A direct `ANTHROPIC_API_KEY` enables Claude Sonnet 4.6, adaptive thinking, and Anthropic's web-search tool. VyceAI uses the OpenAI-compatible `AI_API_*` variables instead; the API key never reaches the browser.

For production rate limiting, create an Upstash Redis database and add its REST URL and token. Without Upstash, a best-effort per-instance fallback is used, which is appropriate only for local development.

Deploy with either the Vercel dashboard or `vercel --prod`. The site has no build step.
