# GradeIQ

GradeIQ is a smart CGPA calculator and academic planning tool for Nigerian university students. Track semesters, predict future performance, plan target grades, and get research-assisted course insights.

## Deploy to Vercel

Import this repository into Vercel, then add one provider configuration under **Project Settings → Environment Variables**. For an OpenAI-compatible provider, set `AI_API_FORMAT=openai`, `AI_API_BASE_URL` to the provider's `/v1` base URL, `AI_API_KEY` to its key, and `AI_MODEL` to a model supported by that provider. For Anthropic, set `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_MODEL`. Redeploy after changing environment variables. The API key never reaches the browser.

If you only have an OpenAI-compatible `AI_API_KEY` configured, the endpoint automatically selects that provider format; setting the base URL and model is still recommended. The tracker can include historical results by entering previous total credit units and previous total quality points (the sum of units multiplied by grade points). Leave both blank to calculate using only the semesters entered below.

For production rate limiting, create an Upstash Redis database and add its REST URL and token. Without Upstash, a best-effort per-instance fallback is used, which is appropriate only for local development.

Deploy with either the Vercel dashboard or `vercel --prod`. The site has no build step.
