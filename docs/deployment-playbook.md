# Deployment Playbook

## How to activate the Rescue Heatmap system after a disaster

**Goal:** Go from earthquake alert to live reporting form in **under 2 hours**.

---

## 🔴 Trigger Criteria

Activate when ALL of the following are true:
- Earthquake magnitude ≥ 6.5 (or ≥ 6.0 in densely populated area)
- Confirmed structural damage and casualties
- USGS PAGER alert: Orange or Red
- Affected country has limited or no official missing persons registry

## 📋 Activation Checklist

### Phase 1: Alert (0–15 minutes)

- [ ] **Detect:** Monitor USGS, EMSC, or local seismological agency alerts
- [ ] **Assess:** Check USGS PAGER for expected impact level
- [ ] **Notify:** Alert the standby team via WhatsApp/Telegram group
- [ ] **Decide:** Team lead confirms GO/NO-GO within 15 minutes

### Phase 2: Configure (15–45 minutes)

- [ ] **Clone** the repo (or use existing deployment)
- [ ] **Update `config.json`:**
  - Event name (e.g., "Colombia Earthquake August 2026")
  - Region / country
  - Primary language(s)
  - Map center coordinates and zoom level
  - Map tile cache bounds (affected area + buffer)
- [ ] **Translate** any new UI strings if needed
- [ ] **Test** locally — form submission, map rendering, offline mode
- [ ] **Deploy** to Vercel/Netlify

### Phase 3: Verify (45–60 minutes)

- [ ] **Test live URL** on mobile (Android + iOS)
- [ ] **Test offline mode** — enable airplane mode, submit form
- [ ] **Verify** data appears in command dashboard
- [ ] **Generate** QR code for the form URL
- [ ] **Prepare** short shareable text in target language(s)

### Phase 4: Distribute (60–120 minutes)

- [ ] Execute [Distribution Playbook](distribution-playbook.md)
- [ ] **Notify INSARAG / OCHA contacts** with the live URL *(no formalized relationship exists yet — do not present the tool as endorsed)*
- [ ] **Monitor** incoming reports on dashboard

---

## 👥 Team Roles

| Role | Responsibility | Required Skills |
|------|---------------|-----------------|
| **Team Lead** | GO/NO-GO decision, coordination | Domain knowledge, communication |
| **Tech Lead** | Deploy, configure, monitor | Git, Vercel, basic frontend |
| **Distribution Lead** | Execute distribution playbook | Social media, local contacts |
| **INSARAG Liaison** | Communicate with UN/international bodies | English, institutional knowledge |
| **Data Monitor** | Watch incoming reports, flag issues | Dashboard literacy, language skills |

## ⚡ Emergency Contacts

> Fill in before an event — not during!

| Role | Name | Phone/WhatsApp | Backup |
|------|------|----------------|--------|
| Team Lead | | | |
| Tech Lead | | | |
| Distribution Lead | | | |
| INSARAG Liaison | | | |

## 🔧 Technical Requirements

- GitHub access (to clone/pull latest version)
- Vercel account (free tier works)
- Domain (optional — Vercel provides subdomain)
- No server management needed — fully serverless

## 📊 Post-Event

- [ ] Export all data (CSV + KML)
- [ ] Archive deployment
- [ ] Write after-action report
- [ ] Update lessons learned
- [ ] Conduct team debrief within 2 weeks
