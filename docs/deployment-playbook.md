# Deployment Playbook

Target: move from a confirmed activation alert to a verified public reporting form within two hours.

## Roles

| Role | Responsibility |
| --- | --- |
| Team Lead | Activation authority, safety, and go/no-go decisions |
| Tech Lead | Infrastructure, configuration, security, and rollback |
| Distribution Lead | Localized messaging and channel coordination |
| INSARAG Liaison | Coordination with INSARAG structures and other responders |
| Data Monitor | Moderation, deduplication, quality, and escalation |

## 1. Alert (0–15 minutes)

- Confirm the incident and activation authority through primary sources.
- Name the incident owner and assign all five roles.
- Open the incident log and record decisions, sources, and timestamps.
- Confirm lawful basis, geographic scope, and safeguarding escalation path.

## 2. Configure (15–60 minutes)

- Create an isolated incident environment and database.
- Set languages, map extent, time zone, retention, and contact information.
- Configure administrator access, MFA, rate limits, backups, and audit logging.
- Load approved offline map tiles and translations.
- Prepare distribution URLs with campaign identifiers but no personal data.

## 3. Verify (60–90 minutes)

- Submit synthetic reports in every supported language.
- Verify geocoding, deduplication, moderation, dashboard access, and exports.
- Test offline field use, synchronization, revocation, and deletion.
- Run a security and privacy check; remove all synthetic data.
- Team Lead records the go/no-go decision.

## 4. Distribute (90–120 minutes)

- Release the URL to trusted local partners first.
- Monitor capacity, abuse, duplicates, and geographic coverage.
- Expand distribution according to the distribution playbook.
- Publish correction and shutdown channels.

## Stop conditions

Do not launch if incident ownership, safeguarding contacts, operational recipients, access control, or deletion/retention policy are missing.
