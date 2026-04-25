# Cloud Scheduler — Policy Recheck Job

Runs `POST /api/recheck` every 24 hours to detect policy changes for watched URLs.

## Setup (one-time)

```bash
# Create the job (free tier: 3 jobs/month)
gcloud scheduler jobs create http tldr-shield-recheck \
  --location=us-central1 \
  --schedule="0 2 * * *" \
  --uri="https://tldr-shield-14714987621.us-central1.run.app/api/recheck" \
  --message-body="{}" \
  --headers="Content-Type=application/json,x-internal-key=YOUR_INTERNAL_API_KEY" \
  --http-method=POST \
  --time-zone="UTC" \
  --attempt-deadline=10m

# Verify
gcloud scheduler jobs list --location=us-central1

# Trigger manually (for testing)
gcloud scheduler jobs run tldr-shield-recheck --location=us-central1
```

## Notes
- Runs at 02:00 UTC daily (off-peak)
- Replace `YOUR_INTERNAL_API_KEY` with the value of `INTERNAL_API_KEY` env var in Cloud Run
- The job uses `attempt-deadline=10m` to handle large watch lists
- Free tier allows up to 3 scheduler jobs
