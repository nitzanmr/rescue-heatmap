# Quarterly Drill Checklist

## Simulated Activation Exercise

**Frequency:** Every 3 months
**Duration:** 2-3 hours
**Goal:** Verify the team can go from alert to live form in under 2 hours

---

## Before the Drill

- [ ] Pick a fictional scenario (country, magnitude, affected area)
- [ ] Notify team 24h in advance (or surprise drill)
- [ ] Ensure Vercel/hosting access is still valid
- [ ] Prepare test data (5-10 fake missing person reports)

## During the Drill

### Phase 1: Alert (0–15 min)
- [ ] Team lead sends alert to group
- [ ] All team members acknowledge within 10 minutes
- [ ] GO/NO-GO decision made

### Phase 2: Deploy (15–45 min)
- [ ] Tech lead clones repo and updates config
- [ ] Form deployed to staging/test URL
- [ ] Verify form works on mobile
- [ ] Verify offline mode works

### Phase 3: Test Data (45–75 min)
- [ ] Team submits 5-10 test reports
- [ ] Verify heatmap updates correctly
- [ ] Test KML/CSV export
- [ ] Verify deduplication (submit similar reports)

### Phase 4: Distribution (75–105 min)
- [ ] Draft distribution messages (don't send externally!)
- [ ] Verify all Tier 1 contacts are still valid
- [ ] Update any stale contacts
- [ ] Review and update message templates if needed

### Phase 5: Debrief (105–120 min)
- [ ] What worked?
- [ ] What was slow or broken?
- [ ] Any contacts that need updating?
- [ ] Action items for before next drill

## After the Drill

- [ ] Clean up test deployment
- [ ] Update contact database
- [ ] Fix any issues found
- [ ] Schedule next drill
- [ ] Document results in `docs/lessons-learned/drills/`

---

## Drill Log

| Date | Scenario | Time to Deploy | Issues Found | Notes |
|------|----------|---------------|--------------|-------|
| | | | | |
